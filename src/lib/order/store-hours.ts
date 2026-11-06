const DAY_KEYS: Record<number, string[]> = {
  0: ["sun", "sunday"],
  1: ["mon", "monday"],
  2: ["tue", "tuesday"],
  3: ["wed", "wednesday"],
  4: ["thu", "thursday"],
  5: ["fri", "friday"],
  6: ["sat", "saturday"],
};

export function parseTimeMinutes(raw: string): number | null {
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

export function findDaySchedule(
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
    "[store-hours] unparseable hours; treating the store as open for the acceptance alert",
    raw,
  );
}

function getStoreLocalTime(timezone: string, now: Date): { dayOfWeek: number; minuteOfDay: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(now);
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const minuteStr = parts.find((p) => p.type === "minute")?.value ?? "0";

  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };

  return {
    dayOfWeek: weekdayMap[weekdayStr] ?? 0,
    minuteOfDay: parseInt(hourStr, 10) * 60 + parseInt(minuteStr, 10),
  };
}

export function isStoreOpen(hours: unknown, timezone: string, now?: Date): boolean {
  if (!hours || typeof hours !== "object") return false;

  const h = hours as Record<string, unknown>;
  const d = now ?? new Date();
  let local: { dayOfWeek: number; minuteOfDay: number };
  try {
    local = getStoreLocalTime(timezone, d);
  } catch {
    return false;
  }

  const todaySchedule = findDaySchedule(h, local.dayOfWeek);
  if (todaySchedule?.kind === "unparseable") {
    logUnparseableHours(todaySchedule.raw);
    return true;
  }
  if (todaySchedule?.kind === "range") {
    const openMin = parseTimeMinutes(todaySchedule.open);
    const closeMin = parseTimeMinutes(todaySchedule.close);
    if (openMin === null || closeMin === null) {
      logUnparseableHours(`${todaySchedule.open}-${todaySchedule.close}`);
      return true;
    }
    if (closeMin > openMin) {
      if (local.minuteOfDay >= openMin && local.minuteOfDay < closeMin) return true;
    } else if (local.minuteOfDay >= openMin) {
      // Overnight: open >= close means the window spans midnight (e.g. 20:00–02:00).
      return true;
    }
  }

  // Yesterday's overnight window can still be open after midnight.
  const yesterdayDow = (local.dayOfWeek + 6) % 7;
  const yesterdaySchedule = findDaySchedule(h, yesterdayDow);
  if (yesterdaySchedule?.kind === "range") {
    const openMin = parseTimeMinutes(yesterdaySchedule.open);
    const closeMin = parseTimeMinutes(yesterdaySchedule.close);
    if (openMin !== null && closeMin !== null && closeMin <= openMin) {
      if (local.minuteOfDay < closeMin) return true;
    }
  }

  return false;
}
