const DAY_KEYS: Record<number, string[]> = {
  0: ["sun", "sunday"],
  1: ["mon", "monday"],
  2: ["tue", "tuesday"],
  3: ["wed", "wednesday"],
  4: ["thu", "thursday"],
  5: ["fri", "friday"],
  6: ["sat", "saturday"],
};

function parseTimeMinutes(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase().replace(/\./g, "");
  // 24h "09:00" / "21:00", 12h "9:00 AM", and compact "9am" / "9 PM".
  const match = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let h = parseInt(match[1], 10);
  const m = match[2] !== undefined ? parseInt(match[2], 10) : 0;
  const ampm = match[3];
  if (m < 0 || m > 59) return null;

  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === "am" && h === 12) h = 0;
    else if (ampm === "pm" && h !== 12) h += 12;
  } else if (h > 23) {
    return null;
  }

  return h * 60 + m;
}

type DaySchedule =
  | { kind: "range"; open: string; close: string }
  | { kind: "closed" }
  | { kind: "unparseable"; raw: string };

function findDaySchedule(
  hours: Record<string, unknown>,
  dayOfWeek: number,
): DaySchedule | null {
  const keys = DAY_KEYS[dayOfWeek];
  if (!keys) return null;

  for (const key of keys) {
    const val = hours[key];
    if (!val) continue;

    if (typeof val === "object" && val !== null) {
      const obj = val as Record<string, unknown>;
      if (obj.closed === true) return { kind: "closed" };
      if (typeof obj.open === "string" && typeof obj.close === "string") {
        return { kind: "range", open: obj.open, close: obj.close };
      }
      return { kind: "unparseable", raw: JSON.stringify(val) };
    }

    if (typeof val === "string") {
      if (/^\s*closed\s*$/i.test(val)) return { kind: "closed" };
      const parts = val.split(/\s*[-–—]\s*/);
      if (parts.length === 2 && parts[0] && parts[1]) {
        return { kind: "range", open: parts[0], close: parts[1] };
      }
      return { kind: "unparseable", raw: val };
    }

    return { kind: "unparseable", raw: String(val) };
  }

  return null;
}
function logUnparseableHours(raw: string): void {
  console.error(
    "[store-hours] unparseable hours; treating the store as open",
    raw,
  );
}

type ParsedDay =
  | { kind: "none" }
  | { kind: "closed" }
  | { kind: "unparseable"; raw: string }
  | { kind: "range"; open: number; close: number };

/** null/undefined = always open. A non-object or an array cannot be parsed, so it counts as open (spec). */
type Schedule =
  | { kind: "always" }
  | { kind: "unparseable"; raw: string }
  | { kind: "weekly"; days: ParsedDay[] };

function describeRaw(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function parseDay(day: DaySchedule | null): ParsedDay {
  if (!day) return { kind: "none" };
  if (day.kind !== "range") return day;
  const open = parseTimeMinutes(day.open);
  const close = parseTimeMinutes(day.close);
  if (open === null || close === null) return { kind: "unparseable", raw: `${day.open}-${day.close}` };
  return { kind: "range", open, close };
}

function parseSchedule(hours: unknown): Schedule {
  if (hours === null || hours === undefined) return { kind: "always" };
  if (typeof hours !== "object" || Array.isArray(hours)) {
    return { kind: "unparseable", raw: describeRaw(hours) };
  }
  const h = hours as Record<string, unknown>;
  return { kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6].map((dow) => parseDay(findDaySchedule(h, dow))) };
}

/**
 * The one open rule: today's range (close exclusive), an unparseable today
 * counts as open, and yesterday's overnight window still counts after midnight.
 */
function openAtLocal(
  days: ParsedDay[],
  dayOfWeek: number,
  minuteOfDay: number,
  log: (raw: string) => void,
): boolean {
  const today = days[dayOfWeek];
  if (today?.kind === "unparseable") {
    log(today.raw);
    return true;
  }
  if (today?.kind === "range") {
    // Equal minutes are a closed range, not an overnight window. A real overnight
    // window is only close strictly before open (20:00–02:00). An equal range adds
    // no interval, so a previous day's overnight window can still be open.
    if (today.close > today.open) {
      if (minuteOfDay >= today.open && minuteOfDay < today.close) return true;
    } else if (today.close < today.open && minuteOfDay >= today.open) {
      return true;
    }
  }
  const yesterday = days[(dayOfWeek + 6) % 7];
  if (yesterday?.kind === "range" && yesterday.close < yesterday.open && minuteOfDay < yesterday.close) {
    return true;
  }
  return false;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** One formatter per zone for the whole process. Throws RangeError for an unknown zone. */
function localFormatter(timezone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    formatterCache.set(timezone, fmt);
  }
  return fmt;
}

interface LocalTime {
  dayOfWeek: number;
  minuteOfDay: number;
  /** The local wall clock read as if it were UTC, at minute precision. */
  wallMs: number;
}

function getStoreLocalTime(timezone: string, now: Date): LocalTime {
  const parts = localFormatter(timezone).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "0";
  const hour = parseInt(get("hour"), 10) % 24;
  const minute = parseInt(get("minute"), 10);
  return {
    dayOfWeek: WEEKDAY_INDEX[get("weekday")] ?? 0,
    minuteOfDay: hour * 60 + minute,
    wallMs: Date.UTC(
      parseInt(get("year"), 10),
      parseInt(get("month"), 10) - 1,
      parseInt(get("day"), 10),
      hour,
      minute,
    ),
  };
}

export function isValidTimezone(timezone: string): boolean {
  try {
    localFormatter(timezone);
    return true;
  } catch {
    return false;
  }
}

/**
 * An invalid zone is closed, checked first, so null hours with a bad zone stay
 * closed. null/undefined hours are always open. Hours that cannot be parsed
 * count as open (spec).
 */
export function isStoreOpen(hours: unknown, timezone: string, now?: Date): boolean {
  const d = now ?? new Date();
  let local: LocalTime;
  try {
    local = getStoreLocalTime(timezone, d);
  } catch {
    return false;
  }
  const schedule = parseSchedule(hours);
  if (schedule.kind === "always") return true;
  if (schedule.kind === "unparseable") {
    logUnparseableHours(schedule.raw);
    return true;
  }
  return openAtLocal(schedule.days, local.dayOfWeek, local.minuteOfDay, logUnparseableHours);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Both scans look at most this far ahead. A card hold lasts 7 days. */
export const STORE_HOURS_SCAN_MS = 7 * 24 * HOUR_MS;

function logOncePerCall(): (raw: string) => void {
  let logged = false;
  return (raw) => {
    if (logged) return;
    logged = true;
    logUnparseableHours(raw);
  };
}

/**
 * isStoreOpen for UTC minute starts, without a formatter call per minute.
 * Every US offset is whole hours and changes on a UTC hour, so the offset is
 * read at both ends of each UTC hour; when they differ, that hour asks the
 * formatter for each minute. The answer is always the one isStoreOpen gives.
 */
function openMinuteProbe(days: ParsedDay[], timezone: string, log: (raw: string) => void) {
  const offsetByHour = new Map<number, number | null>();
  const offsetAt = (ms: number) => getStoreLocalTime(timezone, new Date(ms)).wallMs - ms;
  return (minuteStartMs: number): boolean => {
    const hourStart = Math.floor(minuteStartMs / HOUR_MS) * HOUR_MS;
    let offset = offsetByHour.get(hourStart);
    if (offset === undefined) {
      const first = offsetAt(hourStart);
      offset = first === offsetAt(hourStart + HOUR_MS - MINUTE_MS) ? first : null;
      offsetByHour.set(hourStart, offset);
    }
    if (offset === null) {
      const local = getStoreLocalTime(timezone, new Date(minuteStartMs));
      return openAtLocal(days, local.dayOfWeek, local.minuteOfDay, log);
    }
    const wall = new Date(minuteStartMs + offset);
    return openAtLocal(days, wall.getUTCDay(), wall.getUTCHours() * 60 + wall.getUTCMinutes(), log);
  };
}

/**
 * The earliest instant at or after `now` at which isStoreOpen is true: `now`
 * itself when open, else the start of the first open minute. null when there is
 * none within 7 days, or the zone is invalid.
 */
export function nextOpening(hours: unknown, timezone: string, now: Date): Date | null {
  if (!isValidTimezone(timezone)) return null;
  const schedule = parseSchedule(hours);
  if (schedule.kind === "always") return now;
  if (schedule.kind === "unparseable") {
    logUnparseableHours(schedule.raw);
    return now;
  }
  const open = openMinuteProbe(schedule.days, timezone, logOncePerCall());
  const t0 = now.getTime();
  const first = Math.floor(t0 / MINUTE_MS) * MINUTE_MS;
  if (open(first)) return now;
  for (let m = first + MINUTE_MS; m < t0 + STORE_HOURS_SCAN_MS; m += MINUTE_MS) {
    if (open(m)) return new Date(m);
  }
  return null;
}

/**
 * The instant at which `minutes` minutes of open time (isStoreOpen true) have
 * passed since `start`, to the second: a partial first minute counts by its
 * remaining seconds. null when that is not reached within 7 days of `start`, or
 * the zone is invalid.
 */
export function openMinutesDeadline(
  hours: unknown,
  timezone: string,
  start: Date,
  minutes: number,
): Date | null {
  if (!isValidTimezone(timezone)) return null;
  const s = start.getTime();
  const schedule = parseSchedule(hours);
  if (schedule.kind !== "weekly") {
    if (schedule.kind === "unparseable") logUnparseableHours(schedule.raw);
    return new Date(s + minutes * MINUTE_MS);
  }
  let need = minutes * MINUTE_MS;
  if (need <= 0) return start;
  const open = openMinuteProbe(schedule.days, timezone, logOncePerCall());
  let m = Math.floor(s / MINUTE_MS) * MINUTE_MS;
  if (open(m)) {
    const available = m + MINUTE_MS - s;
    if (available >= need) return new Date(s + need);
    need -= available;
  }
  for (m += MINUTE_MS; m < s + STORE_HOURS_SCAN_MS; m += MINUTE_MS) {
    if (!open(m)) continue;
    if (need <= MINUTE_MS) return new Date(m + need);
    need -= MINUTE_MS;
  }
  return null;
}
