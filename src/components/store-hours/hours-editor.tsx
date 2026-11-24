"use client";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { parseTimeMinutes } from "@/lib/order/store-hours";
import { WEEK_DAYS, type DayHours, type WeekDay, type WeekHours } from "@/lib/store-settings/weekly-hours";

const LABEL = (day: WeekDay) => day[0].toUpperCase() + day.slice(1);

function overnight(day: DayHours): boolean {
  const open = parseTimeMinutes(day.open);
  const close = parseTimeMinutes(day.close);
  return open !== null && close !== null && close < open;
}

/**
 * The weekly hours editor (#786), shared by the owner's Settings page and the platform admin's store form. One row a
 * day: open or closed, then the opening and closing time. A closing time before the opening time runs past midnight.
 */
export function HoursEditor({
  week,
  onChange,
  unreadable = [],
}: {
  week: WeekHours;
  onChange: (week: WeekHours) => void;
  /** Days the saved hours could not be read for; they show closed until set again. */
  unreadable?: WeekDay[];
}) {
  function setDay(day: WeekDay, change: Partial<DayHours>) {
    onChange({ ...week, [day]: { ...week[day], ...change } });
  }

  function copyMonday() {
    onChange(Object.fromEntries(WEEK_DAYS.map((day) => [day, { ...week.monday }])) as WeekHours);
  }

  return (
    <div className="flex flex-col gap-3">
      {unreadable.length > 0 && (
        <p role="note" className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
          The saved hours for {unreadable.map(LABEL).join(", ")} could not be read. They show closed until you set them.
        </p>
      )}
      <ul className="flex flex-col divide-y divide-border" aria-label="Weekly hours">
        {WEEK_DAYS.map((day) => {
          const hours = week[day];
          return (
            <li key={day} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4" data-testid={`hours-${day}`}>
              <div className="flex min-h-11 items-center justify-between gap-3 sm:w-44 sm:shrink-0">
                <span className="text-sm font-medium text-foreground">{LABEL(day)}</span>
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  {hours.closed ? "Closed" : "Open"}
                  <Switch
                    checked={!hours.closed}
                    onCheckedChange={(open) => setDay(day, { closed: !open })}
                    aria-label={`${LABEL(day)} open`}
                  />
                </span>
              </div>
              {!hours.closed && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="time"
                    value={hours.open}
                    onChange={(event) => setDay(day, { open: event.target.value })}
                    aria-label={`${LABEL(day)} opens`}
                    className="h-11 w-32"
                    required
                  />
                  <span className="text-sm text-muted-foreground">to</span>
                  <Input
                    type="time"
                    value={hours.close}
                    onChange={(event) => setDay(day, { close: event.target.value })}
                    aria-label={`${LABEL(day)} closes`}
                    className="h-11 w-32"
                    required
                  />
                  {overnight(hours) && <span className="text-sm text-muted-foreground">next day</span>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={copyMonday}
        className="inline-flex min-h-11 items-center self-start text-sm font-medium text-primary underline underline-offset-4"
      >
        Use Monday&apos;s hours every day
      </button>
    </div>
  );
}
