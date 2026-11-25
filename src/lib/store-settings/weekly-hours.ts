import { parseTimeMinutes } from "../order/store-hours";

/** The week in the order the store admin shows it; also the keys the storefront hours block reads. */
export const WEEK_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

/** One day in the hours editor. Times are 24-hour "HH:MM", what a time input gives. */
export type DayHours = { closed: boolean; open: string; close: string };
export type WeekHours = Record<WeekDay, DayHours>;

export const DEFAULT_WEEK: WeekHours = Object.fromEntries(
  WEEK_DAYS.map((day) => [day, { closed: false, open: "09:00", close: "20:00" }]),
) as WeekHours;

const SHORT: Record<WeekDay, string> = {
  monday: "mon", tuesday: "tue", wednesday: "wed", thursday: "thu", friday: "fri", saturday: "sat", sunday: "sun",
};

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function readDay(raw: unknown): DayHours | "unreadable" {
  const closed = { ...DEFAULT_WEEK.monday, closed: true };
  if (raw == null || raw === "") return closed;
  let open: unknown;
  let close: unknown;
  if (typeof raw === "string") {
    if (/^\s*closed\s*$/i.test(raw)) return closed;
    [open, close] = raw.split(/\s*[-–—]\s*/);
  } else if (typeof raw === "object") {
    const day = raw as Record<string, unknown>;
    if (day.closed === true) return closed;
    ({ open, close } = day);
  }
  const from = typeof open === "string" ? parseTimeMinutes(open) : null;
  const to = typeof close === "string" ? parseTimeMinutes(close) : null;
  if (from === null || to === null) return "unreadable";
  return { closed: false, open: clock(from), close: clock(to) };
}

/**
 * Stored hours as the editor's week (#786). Reads every shape checkout accepts (store-hours.ts); a day it cannot read
 * is named in `unreadable` and shown closed, so the editor never drops it silently. No hours at all reads as null.
 */
export function readWeeklyHours(hours: unknown): { week: WeekHours; unreadable: WeekDay[] } | null {
  if (typeof hours !== "object" || hours === null || Array.isArray(hours)) return null;
  const stored = hours as Record<string, unknown>;
  const unreadable: WeekDay[] = [];
  const week = Object.fromEntries(WEEK_DAYS.map((day) => {
    const read = readDay(stored[day] ?? stored[SHORT[day]]);
    if (read === "unreadable") unreadable.push(day);
    return [day, read === "unreadable" ? { ...DEFAULT_WEEK[day], closed: true } : read];
  })) as WeekHours;
  return { week, unreadable };
}

export function twelveHour(time: string): string {
  const minutes = parseTimeMinutes(time) ?? 0;
  const h = Math.floor(minutes / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(minutes % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** The week as stored: full day names, "9:00 AM - 8:00 PM" or "Closed", the shape the storefront shows. */
export function writeWeeklyHours(week: WeekHours): Record<WeekDay, string> {
  return Object.fromEntries(
    WEEK_DAYS.map((day) => [day, week[day].closed ? "Closed" : `${twelveHour(week[day].open)} - ${twelveHour(week[day].close)}`]),
  ) as Record<WeekDay, string>;
}

const LABEL = (day: WeekDay) => day[0].toUpperCase() + day.slice(1);

/** Why the week cannot be saved, or null. Closing before opening is an overnight day, which checkout supports. */
export function weeklyHoursError(week: WeekHours): string | null {
  for (const day of WEEK_DAYS) {
    const { closed, open, close } = week[day];
    if (closed) continue;
    const from = parseTimeMinutes(open);
    const to = parseTimeMinutes(close);
    if (from === null || to === null) return `${LABEL(day)}: enter an opening and a closing time.`;
    if (from === to) return `${LABEL(day)}: the closing time must differ from the opening time.`;
  }
  if (WEEK_DAYS.every((day) => week[day].closed)) return "Open the store on at least one day.";
  return null;
}
