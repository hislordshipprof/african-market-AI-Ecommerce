import {
  DEFAULT_SLOT_MINUTES,
  MAX_DAYS_AHEAD,
  MIN_LEAD_MINUTES,
  formatWindows,
  parseWindows,
  readSlotSchedule,
  type SlotSchedule,
} from "../order/slot-schedule";

/** Form field prefixes for the two scheduled fulfillments (#565). */
export const SLOT_FORMS = [
  { prefix: "pickupSlots", column: "pickupSlotSettings", title: "Pickup slots" },
  { prefix: "deliverySlots", column: "storeDeliverySlotSettings", title: "Store delivery slots" },
] as const;
export type SlotFormPrefix = (typeof SLOT_FORMS)[number]["prefix"];

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const SETTINGS = ["Enabled", "Minutes", "Lead", "Capacity", "DaysAhead", "Closed"] as const;

export function slotFieldNames(prefix: SlotFormPrefix): string[] {
  return [...SETTINGS, ...WEEKDAYS].map((suffix) => `${prefix}${suffix}`);
}

export const SLOT_FIELD_NAMES = SLOT_FORMS.flatMap((form) => slotFieldNames(form.prefix));

function whole(raw: string | null, fallback: number): number {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : NaN;
}

/** A schedule from the form, null when the box is unticked, or field errors keyed by field name. */
export function readSlotForm(
  read: (key: string) => string | null,
  prefix: SlotFormPrefix,
): { schedule: SlotSchedule | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (read(`${prefix}Enabled`) !== "on") return { schedule: null, errors };
  const slotMinutes = whole(read(`${prefix}Minutes`), DEFAULT_SLOT_MINUTES);
  const leadMinutes = whole(read(`${prefix}Lead`), MIN_LEAD_MINUTES);
  const capacity = whole(read(`${prefix}Capacity`), 1);
  const daysAhead = whole(read(`${prefix}DaysAhead`), 1);
  if (!(slotMinutes >= 15 && slotMinutes <= 240 && slotMinutes % 15 === 0)) {
    errors[`${prefix}Minutes`] = "Slot length must be 15-240 minutes, in steps of 15";
  }
  if (!(leadMinutes >= MIN_LEAD_MINUTES && leadMinutes <= 2880)) {
    errors[`${prefix}Lead`] = "Lead time must be at least 120 minutes";
  }
  if (!(capacity >= 1 && capacity <= 500)) errors[`${prefix}Capacity`] = "Orders per slot must be 1-500";
  if (!(daysAhead >= 1 && daysAhead <= MAX_DAYS_AHEAD)) errors[`${prefix}DaysAhead`] = "Days ahead must be 1-5";
  const closedDates = (read(`${prefix}Closed`) ?? "").split(",").map((date) => date.trim()).filter(Boolean);
  if (closedDates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) {
    errors[`${prefix}Closed`] = "Closed dates must be YYYY-MM-DD, separated by commas";
  }
  const windows = WEEKDAYS.map((day) => {
    const parsed = parseWindows(read(`${prefix}${day}`) ?? "");
    if (!parsed) errors[`${prefix}${day}`] = "Use times like 9:00 AM - 12:00 PM, 2:00 PM - 6:00 PM";
    return parsed ?? [];
  });
  const windowErrors = WEEKDAYS.some((day) => errors[`${prefix}${day}`]);
  if (!windowErrors && windows.every((day) => day.length === 0)) {
    errors[`${prefix}Mon`] = "Add at least one window, or untick scheduled slots";
  }
  if (Object.keys(errors).length > 0) return { schedule: null, errors };
  const schedule = readSlotSchedule({ slotMinutes, leadMinutes, capacity, daysAhead, closedDates, windows });
  if (!schedule) return { schedule: null, errors: { [`${prefix}Enabled`]: "These slot settings are not valid" } };
  return { schedule, errors };
}

/** Form values for a stored schedule; an unset one shows the defaults with the box unticked. */
export function slotFormValues(raw: unknown, prefix: SlotFormPrefix): Record<string, string> {
  const schedule = readSlotSchedule(raw);
  const values: Record<string, string> = {
    [`${prefix}Enabled`]: schedule ? "on" : "",
    [`${prefix}Minutes`]: String(schedule?.slotMinutes ?? DEFAULT_SLOT_MINUTES),
    [`${prefix}Lead`]: String(schedule?.leadMinutes ?? MIN_LEAD_MINUTES),
    [`${prefix}Capacity`]: String(schedule?.capacity ?? 4),
    [`${prefix}DaysAhead`]: String(schedule?.daysAhead ?? 3),
    [`${prefix}Closed`]: schedule?.closedDates.join(", ") ?? "",
  };
  WEEKDAYS.forEach((day, index) => {
    values[`${prefix}${day}`] = schedule ? formatWindows(schedule.windows[index]) : "";
  });
  return values;
}
