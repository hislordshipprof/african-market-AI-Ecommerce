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

export function isStoreOpen(hours: unknown, now?: Date): boolean {
  if (!hours || typeof hours !== "object") return false;

  const h = hours as Record<string, unknown>;
  const d = now ?? new Date();
  const schedule = findDaySchedule(h, d.getDay());
  if (!schedule) return false;

  const openMin = parseTimeMinutes(schedule.open);
  const closeMin = parseTimeMinutes(schedule.close);
  if (openMin === null || closeMin === null) return false;

  const currentMin = d.getHours() * 60 + d.getMinutes();
  return currentMin >= openMin && currentMin < closeMin;
}
