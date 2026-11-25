"use client";

import { CircleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SLOT_FORMS, WEEKDAYS, slotGapWarning, type SlotFormPrefix } from "@/lib/admin/slot-form";
import { formatWindows } from "@/lib/order/slot-schedule";
import { parseTimeMinutes } from "@/lib/order/store-hours";
import { writeWeeklyHours, type WeekDay, type WeekHours } from "@/lib/store-settings/weekly-hours";

const DAY_OF: Record<(typeof WEEKDAYS)[number], WeekDay> = {
  Sun: "sunday", Mon: "monday", Tue: "tuesday", Wed: "wednesday", Thu: "thursday", Fri: "friday", Sat: "saturday",
};

const NUMBERS = [
  { suffix: "Minutes", label: "Slot length", unit: "minutes", min: 15, max: 240, step: 15 },
  { suffix: "Lead", label: "Lead time", unit: "minutes", min: 120, max: 2880, step: 15 },
  { suffix: "Capacity", label: "Orders per slot", unit: "", min: 1, max: 500, step: 1 },
  { suffix: "DaysAhead", label: "Days ahead", unit: "1 to 5", min: 1, max: 5, step: 1 },
];

/** Each open day's hours as one window, so turning slots on starts inside the hours. An overnight day starts empty. */
function windowsFromHours(hours: WeekHours, prefix: SlotFormPrefix): Record<string, string> {
  return Object.fromEntries(WEEKDAYS.map((day) => {
    const { closed, open, close } = hours[DAY_OF[day]];
    const start = parseTimeMinutes(open);
    const end = parseTimeMinutes(close);
    const fits = !closed && start !== null && end !== null && end > start;
    return [`${prefix}${day}`, fits ? formatWindows([{ start, end }]) : ""];
  }));
}

/** The owner's pickup and store-delivery slots (#807): the same fields and rules as the platform admin store form. */
export function SlotSettings({
  slots,
  onChange,
  hours,
  timezone,
  now,
}: {
  slots: Record<string, string>;
  onChange: (slots: Record<string, string>) => void;
  hours: WeekHours;
  timezone: string;
  now: Date;
}) {
  const read = (key: string) => slots[key] ?? null;
  const storedHours = writeWeeklyHours(hours);

  function set(next: Record<string, string>) {
    onChange({ ...slots, ...next });
  }

  function toggle(prefix: SlotFormPrefix, on: boolean) {
    const empty = WEEKDAYS.every((day) => !(slots[`${prefix}${day}`] ?? "").trim());
    set({ [`${prefix}Enabled`]: on ? "on" : "", ...(on && empty ? windowsFromHours(hours, prefix) : {}) });
  }

  return (
    <div className="flex flex-col gap-6">
      {SLOT_FORMS.map(({ prefix, title }) => {
        const on = slots[`${prefix}Enabled`] === "on";
        const warning = on ? slotGapWarning(read, prefix, storedHours, timezone, now) : null;
        return (
          <section key={prefix} aria-labelledby={`${prefix}-title`} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <div className="flex min-h-11 items-center justify-between gap-4">
                <label id={`${prefix}-title`} htmlFor={`${prefix}Enabled`} className="text-sm font-medium text-foreground">
                  {title}
                </label>
                <Switch
                  id={`${prefix}Enabled`}
                  checked={on}
                  onCheckedChange={(checked) => toggle(prefix, checked)}
                  aria-describedby={`${prefix}-state`}
                />
              </div>
              <p id={`${prefix}-state`} className="text-sm text-muted-foreground">
                {on
                  ? "Shoppers book one of these times at checkout."
                  : prefix === "pickupSlots"
                    ? "Off: pickup offers today's half hours."
                    : "Off: store delivery goes as soon as possible."}
              </p>
            </div>
            {on && (
              <>
                {warning && (
                  <p role="status" className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    {warning}
                  </p>
                )}
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {NUMBERS.map((field) => (
                    <div key={field.suffix} className="flex flex-col gap-2">
                      <Label htmlFor={`${prefix}${field.suffix}`}>{field.label}</Label>
                      <Input
                        id={`${prefix}${field.suffix}`}
                        type="number"
                        inputMode="numeric"
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        value={slots[`${prefix}${field.suffix}`] ?? ""}
                        onChange={(event) => set({ [`${prefix}${field.suffix}`]: event.target.value })}
                        aria-describedby={field.unit ? `${prefix}${field.suffix}-unit` : undefined}
                        className="h-11"
                      />
                      {field.unit && (
                        <p id={`${prefix}${field.suffix}-unit`} className="text-xs text-muted-foreground">{field.unit}</p>
                      )}
                    </div>
                  ))}
                </div>
                <fieldset className="flex flex-col gap-3">
                  <legend className="mb-1 text-sm font-medium text-foreground">Times by day</legend>
                  <p className="text-sm text-muted-foreground">
                    Like 9:00 AM - 12:00 PM, 2:00 PM - 6:00 PM. Leave a day empty for no slots. Slots outside your
                    opening hours are not offered.
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {WEEKDAYS.map((day) => (
                      <div key={day} className="flex flex-col gap-2">
                        <Label htmlFor={`${prefix}${day}`}>{DAY_OF[day][0].toUpperCase() + DAY_OF[day].slice(1)}</Label>
                        <Input
                          id={`${prefix}${day}`}
                          value={slots[`${prefix}${day}`] ?? ""}
                          onChange={(event) => set({ [`${prefix}${day}`]: event.target.value })}
                          className="h-11"
                        />
                      </div>
                    ))}
                  </div>
                </fieldset>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`${prefix}Closed`}>Closed dates</Label>
                  <Input
                    id={`${prefix}Closed`}
                    value={slots[`${prefix}Closed`] ?? ""}
                    onChange={(event) => set({ [`${prefix}Closed`]: event.target.value })}
                    placeholder="2026-12-25, 2027-01-01"
                    aria-describedby={`${prefix}Closed-hint`}
                    className="h-11"
                  />
                  <p id={`${prefix}Closed-hint`} className="text-xs text-muted-foreground">Dates with no slots, separated by commas.</p>
                </div>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
