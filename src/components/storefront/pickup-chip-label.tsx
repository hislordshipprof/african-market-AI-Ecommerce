"use client";
import { useSyncExternalStore } from "react";
import { openStatus } from "@/lib/directory/open-status";

const MINUTE_MS = 60_000;

function subscribe(onChange: () => void) {
  const id = setInterval(onChange, MINUTE_MS / 2);
  return () => clearInterval(id);
}

const currentMinute = () => Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;

/** A pickup time only while the store is open; otherwise when it opens (#763). */
export function pickupChipLabel(minutes: number, hours: unknown, timezone: string, now: Date, viewerZone?: string): string {
  const status = openStatus(hours, timezone, now, viewerZone);
  // Closed: only when it opens, which fits the chip on a phone.
  return status.open ? `Pickup · ${minutes} min` : status.detail ?? status.label;
}

/** Worked out in the browser each minute, like the directory's Open now: "Pickup" until then. */
export default function PickupChipLabel({ minutes, hours, timezone }: { minutes: number; hours: unknown; timezone: string }) {
  const minute = useSyncExternalStore(subscribe, currentMinute, () => null);
  if (minute === null) return <>Pickup</>;
  return <>{pickupChipLabel(minutes, hours, timezone, new Date(minute), Intl.DateTimeFormat().resolvedOptions().timeZone)}</>;
}
