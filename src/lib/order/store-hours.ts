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
  const trimmed = raw.trim().toLowerCase();

  // "HH:MM" (24h)
  const match24 = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    const h = parseInt(match24[1], 10);
    const m = parseInt(match24[2], 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return h * 60 + m;
    return null;
  }

  // "H:MM AM/PM" (12h)
  const match12 = trimmed.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
  if (match12) {
    let h = parseInt(match12[1], 10);
    const m = parseInt(match12[2], 10);
    const ampm = match12[3];
    if (h < 1 || h > 12 || m < 0 || m > 59) return null;
    if (ampm === "am" && h === 12) h = 0;
    else if (ampm === "pm" && h !== 12) h += 12;
    return h * 60 + m;
  }

  return null;
}

function findDaySchedule(
  hours: Record<string, unknown>,
  dayOfWeek: number,
): { open: string; close: string } | null {
  const keys = DAY_KEYS[dayOfWeek];
  if (!keys) return null;

  for (const key of keys) {
    const val = hours[key];
    if (!val) continue;

    // Object format: { open: "09:00", close: "20:00" }
    if (typeof val === "object" && val !== null) {
      const obj = val as Record<string, unknown>;
      if (typeof obj.open === "string" && typeof obj.close === "string") {
        return { open: obj.open, close: obj.close };
      }
    }

    // String format: "9:00 AM - 8:00 PM"
    if (typeof val === "string") {
      const parts = val.split(/\s*[-–]\s*/);
      if (parts.length === 2) {
        return { open: parts[0], close: parts[1] };
      }
    }
  }

  return null;
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
  const local = getStoreLocalTime(timezone, d);

  const todaySchedule = findDaySchedule(h, local.dayOfWeek);
  if (todaySchedule) {
    const openMin = parseTimeMinutes(todaySchedule.open);
    const closeMin = parseTimeMinutes(todaySchedule.close);
    if (openMin !== null && closeMin !== null) {
      if (closeMin > openMin) {
        if (local.minuteOfDay >= openMin && local.minuteOfDay < closeMin) return true;
      } else {
        // Overnight: open >= close means open spans midnight (e.g. 20:00–02:00)
        if (local.minuteOfDay >= openMin) return true;
      }
    }
  }

  // Check yesterday's schedule for overnight window carrying into today
  const yesterdayDow = (local.dayOfWeek + 6) % 7;
  const yesterdaySchedule = findDaySchedule(h, yesterdayDow);
  if (yesterdaySchedule) {
    const openMin = parseTimeMinutes(yesterdaySchedule.open);
    const closeMin = parseTimeMinutes(yesterdaySchedule.close);
    if (openMin !== null && closeMin !== null && closeMin <= openMin) {
      if (local.minuteOfDay < closeMin) return true;
    }
  }

  return false;
}
