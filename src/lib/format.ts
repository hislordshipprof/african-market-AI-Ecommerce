const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const money = (cents: number) => usd.format(cents / 100);

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatWeight(grams: number): string {
  if (grams >= 1000) return `${(grams / 1000).toFixed(1).replace(/\.0$/, "")} kg`;
  return `${grams} g`;
}

/** A date in a list (#737): "Today", "Yesterday" or "Nov 1, 2026", by the store's calendar day. */
export function formatListDate(date: Date | string, timeZone: string, now: Date = new Date()): string {
  let calendar: Intl.DateTimeFormat;
  try {
    calendar = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" });
  } catch {
    calendar = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric" });
  }
  const day = (at: Date | string) => {
    const parts = calendar.formatToParts(new Date(at));
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(part("year"), part("month") - 1, part("day"));
  };
  const daysAgo = (day(now) - day(date)) / 86_400_000;
  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  return formatInZone(date, timeZone, { month: "short", day: "numeric", year: "numeric" });
}

/** A date in the store's zone. `stores.timezone` is free text in the DB, so an unknown zone falls back to New York instead of throwing. */
export function formatInZone(date: Date | string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  const at = new Date(date);
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "America/New_York" }).format(at);
  }
}

/** An operational clock time in the store's zone, labelled with the zone: "3:05 PM CST". */
export function formatClockInZone(date: Date | string, timeZone: string): string {
  return formatInZone(date, timeZone, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

/** A time in a list (#737): "Today, 3:05 PM CST". */
export function formatListTime(date: Date | string, timeZone: string, now: Date = new Date()): string {
  return `${formatListDate(date, timeZone, now)}, ${formatClockInZone(date, timeZone)}`;
}

/** A US number as (202) 555-0100 whatever was typed; anything else stays as the customer typed it. */
export function formatUsPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length !== 10) return phone.trim();
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
}

/** A `tel:` link for a phone; a 10-digit US number gets +1. */
export function telHref(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `tel:+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `tel:+${digits}`;
  return `tel:${phone.trim().startsWith("+") ? "+" : ""}${digits}`;
}

/** Google Maps directions to an address. */
export function mapsUrl(address: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
}
