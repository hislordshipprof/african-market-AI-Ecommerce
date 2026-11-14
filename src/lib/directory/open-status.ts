import { getStoreLocalTime, isStoreOpen, nextOpening } from "@/lib/order/store-hours";

export type OpenStatus = { open: boolean; label: "Open now" | "Closed"; detail: string | null };

const DAY_MS = 86_400_000;
const CLOSED: OpenStatus = { open: false, label: "Closed", detail: null };

function zoneName(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" })
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName")?.value ?? "";
}

/**
 * A directory card's "Open now" or "Opens 9 AM", from the store's public hours and the same
 * rule orders use (isStoreOpen, nextOpening). Times are on the store's clock; its zone is
 * named when the shopper's differs (#453).
 */
export function openStatus(hours: unknown, timezone: string, now: Date, viewerZone?: string): OpenStatus {
  if (isStoreOpen(hours, timezone, now)) return { open: true, label: "Open now", detail: null };
  const opening = nextOpening(hours, timezone, now);
  if (!opening) return CLOSED;

  const days = Math.floor(getStoreLocalTime(timezone, opening).wallMs / DAY_MS) - Math.floor(getStoreLocalTime(timezone, now).wallMs / DAY_MS);
  const day = days === 0
    ? ""
    : days === 1
      ? "tomorrow "
      : `${new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(opening)} `;
  const time = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" })
    .format(opening)
    .replace(":00", "")
    .replace(/\s/g, " ");
  const zone = zoneName(timezone, opening);
  const named = viewerZone && zoneName(viewerZone, opening) !== zone ? ` ${zone}` : "";
  return { open: false, label: "Closed", detail: `Opens ${day}${time}${named}` };
}
