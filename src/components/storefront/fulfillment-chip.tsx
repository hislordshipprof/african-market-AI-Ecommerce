"use client";
import { useState, useSyncExternalStore } from "react";
import { MapPin, ChevronDown } from "lucide-react";
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

export function FulfillmentChip({
  minutes,
  pickup,
  radius,
  hours,
  timezone,
}: {
  minutes: number;
  pickup: boolean;
  radius: number;
  hours: unknown;
  timezone: string;
}) {
  // Worked out in the browser each minute, like the directory's Open now: blank until then.
  const minute = useSyncExternalStore(subscribe, currentMinute, () => null);
  const [open, setOpen] = useState(false);
  const [zip, setZip] = useState("");
  const [draft, setDraft] = useState("");
  return (
    <div className="sf-fulfillment">
      <button
        className="sf-window-chip"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MapPin size={16} aria-hidden />
        <span>
          {!pickup
            ? "Local delivery"
            : minute === null
              ? "Pickup"
              : pickupChipLabel(minutes, hours, timezone, new Date(minute), Intl.DateTimeFormat().resolvedOptions().timeZone)}
          <small>{zip || "Set ZIP code"}</small>
        </span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <form
          className="sf-zip-popover"
          onSubmit={(e) => {
            e.preventDefault();
            if (/^\d{5}$/.test(draft)) {
              setZip(draft);
              setOpen(false);
            }
          }}
        >
          <label htmlFor="delivery-zip">Your ZIP code</label>
          <p>
            Store delivery within {radius} miles. Availability confirmed at
            checkout. This temporary note lasts until you leave this page; it does not check delivery coverage.
          </p>
          <input
            id="delivery-zip"
            inputMode="numeric"
            pattern="[0-9]{5}"
            maxLength={5}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            required
            autoComplete="postal-code"
          />
          <button className="sf-button" type="submit">
            Note ZIP for now
          </button>
          <button
            type="button"
            className="sf-chip"
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}
