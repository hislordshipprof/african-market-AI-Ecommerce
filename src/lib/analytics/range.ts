/** Store-day date ranges for the analytics dashboard (#498). Days are YYYY-MM-DD in the store's time zone, inclusive. */
export const RANGE_PRESETS = [7, 30, 90] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
const MAX_CUSTOM_DAYS = 366;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface AnalyticsRange {
  /** 7, 30 or 90, or "custom". */
  preset: RangePreset | "custom";
  from: string;
  to: string;
}

export function storeToday(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validDay(day: string | undefined): day is string {
  if (!day || !DAY_PATTERN.test(day)) return false;
  return new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

export function daySpan(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Reads `range`, `from` and `to` search params. Anything invalid falls back to the last 30 days. */
export function resolveRange(
  params: { range?: string; from?: string; to?: string },
  timeZone: string,
  now: Date = new Date(),
): AnalyticsRange {
  const today = storeToday(timeZone, now);
  if (params.range === "custom" && validDay(params.from) && validDay(params.to)) {
    const to = params.to > today ? today : params.to;
    const span = daySpan(params.from, to);
    if (span >= 1 && span <= MAX_CUSTOM_DAYS) return { preset: "custom", from: params.from, to };
  }
  const preset = RANGE_PRESETS.find((days) => String(days) === params.range) ?? 30;
  return { preset, from: addDays(today, 1 - preset), to: today };
}

/** Every day in the range, so days with no orders still show as zero. */
export function rangeDays(range: Pick<AnalyticsRange, "from" | "to">): string[] {
  const days: string[] = [];
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) days.push(day);
  return days;
}
