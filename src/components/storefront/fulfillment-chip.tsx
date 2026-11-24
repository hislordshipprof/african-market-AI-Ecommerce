"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { MapPin, ChevronDown } from "lucide-react";

// Loaded after first paint: the store-hours rules would push the storefront home over its JS budget (#629).
const PickupChipLabel = dynamic(() => import("./pickup-chip-label"), { ssr: false, loading: () => <>Pickup</> });

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
          {pickup ? <PickupChipLabel minutes={minutes} hours={hours} timezone={timezone} /> : "Local delivery"}
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
