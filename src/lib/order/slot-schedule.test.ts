import { describe, expect, it } from "vitest";
import { formatWindows, parseWindows, pickupSlotsFor, readSlotSchedule, scheduledSlots, type SlotSchedule } from "./slot-schedule";

const CHICAGO = "America/Chicago";
const NINE_TO_NOON = [{ start: 9 * 60, end: 12 * 60 }];

function schedule(overrides: Partial<SlotSchedule> = {}): SlotSchedule {
  return {
    slotMinutes: 60,
    leadMinutes: 120,
    capacity: 2,
    daysAhead: 2,
    closedDates: [],
    windows: [NINE_TO_NOON, NINE_TO_NOON, NINE_TO_NOON, NINE_TO_NOON, NINE_TO_NOON, NINE_TO_NOON, NINE_TO_NOON],
    ...overrides,
  };
}

const ids = (slots: { id: string }[]) => slots.map((slot) => slot.id);

describe("scheduledSlots", () => {
  it("cuts each weekday window into slots in store time, after the lead time and inside days ahead", () => {
    // Tue 2026-11-17 08:30 CST. Lead 2 h: 9:00 and 10:00 are too soon; 11:00 is the first slot.
    const slots = scheduledSlots(schedule(), null, CHICAGO, new Date("2026-11-17T14:30:00Z"), new Map());
    expect(ids(slots)).toEqual([
      "2026-11-17T17:00:00.000Z",
      "2026-11-18T15:00:00.000Z",
      "2026-11-18T16:00:00.000Z",
      "2026-11-18T17:00:00.000Z",
    ]);
    expect(slots[0].label).toBe("Tue, Nov 17, 11:00 AM – 12:00 PM CST");
  });

  it("drops full slots and closed dates, and a slot must end within days ahead", () => {
    const now = new Date("2026-11-17T14:30:00Z");
    const booked = new Map([["2026-11-18T15:00:00.000Z", 2], ["2026-11-18T16:00:00.000Z", 1]]);
    expect(ids(scheduledSlots(schedule({ closedDates: ["2026-11-17"] }), null, CHICAGO, now, booked))).toEqual([
      "2026-11-18T16:00:00.000Z",
      "2026-11-18T17:00:00.000Z",
    ]);
    // One day ahead: tomorrow 9:00 ends 10:00 CST, past now + 24 h (08:30 CST).
    expect(ids(scheduledSlots(schedule({ daysAhead: 1 }), null, CHICAGO, now, new Map()))).toEqual(["2026-11-17T17:00:00.000Z"]);
  });

  it("skips the spring-forward gap and lists a repeated fall-back hour once", () => {
    const early = [{ start: 60, end: 4 * 60 }];
    const sundays = (window: typeof early) => schedule({ windows: [window, [], [], [], [], [], []] });
    // Sun 2026-03-08 in Chicago: 2:00 AM does not exist.
    const spring = scheduledSlots(sundays(early), null, CHICAGO, new Date("2026-03-07T12:00:00Z"), new Map());
    expect(ids(spring)).toEqual(["2026-03-08T07:00:00.000Z", "2026-03-08T08:00:00.000Z"]);
    expect(spring[1].label).toContain("3:00");
    // Sun 2026-11-01: 1:00 AM happens twice; the first one is the slot.
    const fall = scheduledSlots(sundays(early), null, CHICAGO, new Date("2026-10-31T12:00:00Z"), new Map());
    expect(ids(fall)).toEqual(["2026-11-01T06:00:00.000Z", "2026-11-01T08:00:00.000Z", "2026-11-01T09:00:00.000Z"]);
  });

  it("offers a slot only while the store is open for all of it, in store time (#807)", () => {
    // Walkthrough: Tue 9 AM-8 PM; a 10:00 PM pickup slot was booked.
    const hours = { tuesday: "9:00 AM - 8:00 PM", wednesday: "Closed" };
    const evenings = [{ start: 18 * 60, end: 23 * 60 }];
    const tuesday = schedule({ windows: [[], [], evenings, evenings, [], [], []], daysAhead: 2 });
    // Tue 2026-11-17 08:30 CST. 6-7 PM and 7-8 PM end by closing; 8 PM onward is closed. Wednesday is closed all day.
    expect(ids(scheduledSlots(tuesday, hours, CHICAGO, new Date("2026-11-17T14:30:00Z"), new Map()))).toEqual([
      "2026-11-18T00:00:00.000Z",
      "2026-11-18T01:00:00.000Z",
    ]);
    // A slot that runs past closing is dropped too.
    const twoHours = schedule({ slotMinutes: 120, windows: [[], [], [{ start: 17 * 60, end: 21 * 60 }], [], [], [], []] });
    expect(ids(scheduledSlots(twoHours, hours, CHICAGO, new Date("2026-11-17T14:30:00Z"), new Map()))).toEqual([
      "2026-11-17T23:00:00.000Z",
    ]);
  });

  it("offers nothing for an invalid zone", () => {
    expect(scheduledSlots(schedule(), null, "Not/AZone", new Date("2026-11-17T14:30:00Z"), new Map())).toEqual([]);
  });
});

describe("readSlotSchedule", () => {
  it("accepts the stored shape and rejects out-of-range settings", () => {
    expect(readSlotSchedule(schedule())).toEqual(schedule());
    expect(readSlotSchedule(null)).toBeNull();
    expect(readSlotSchedule(schedule({ daysAhead: 6 }))).toBeNull();
    expect(readSlotSchedule(schedule({ leadMinutes: 60 }))).toBeNull();
    expect(readSlotSchedule(schedule({ capacity: 0 }))).toBeNull();
    expect(readSlotSchedule(schedule({ windows: [[{ start: 600, end: 540 }], [], [], [], [], [], []] }))).toBeNull();
  });
});

describe("parseWindows", () => {
  it("reads comma-separated ranges and round-trips them", () => {
    const windows = parseWindows("9:00 AM - 12:00 PM, 14:00-18:00");
    expect(windows).toEqual([{ start: 540, end: 720 }, { start: 840, end: 1080 }]);
    expect(formatWindows(windows!)).toBe("9:00 AM - 12:00 PM, 2:00 PM - 6:00 PM");
    expect(parseWindows("")).toEqual([]);
    expect(parseWindows("closed")).toEqual([]);
    expect(parseWindows("6 PM - 9 AM")).toBeNull();
    expect(parseWindows("noon")).toBeNull();
  });
});

describe("pickupSlotsFor", () => {
  const store = {
    hours: null,
    timezone: CHICAGO,
    prepTimeMinutes: 30,
    pickupEnabled: true,
  };

  it("keeps today's half-hour slots when the store has no pickup schedule", () => {
    const slots = pickupSlotsFor({ ...store, pickupSlotSettings: null }, new Date("2026-11-17T14:30:00Z"), new Map());
    expect(slots[0].id).toBe("asap");
    expect(slots[1].id).toBe("2026-11-17T15:00:00.000Z");
  });

  it("uses the schedule, after ASAP, once the store sets one", () => {
    const slots = pickupSlotsFor({ ...store, pickupSlotSettings: schedule() }, new Date("2026-11-17T14:30:00Z"), new Map());
    expect(ids(slots)).toEqual(["asap", "2026-11-17T17:00:00.000Z", "2026-11-18T15:00:00.000Z", "2026-11-18T16:00:00.000Z", "2026-11-18T17:00:00.000Z"]);
  });

  it("keeps scheduled pickup inside the store's hours (#807)", () => {
    const hours = { tuesday: "10:00 AM - 8:00 PM", wednesday: "Closed" };
    const slots = pickupSlotsFor({ ...store, hours, pickupSlotSettings: schedule() }, new Date("2026-11-17T14:30:00Z"), new Map());
    expect(ids(slots)).toEqual(["2026-11-17T17:00:00.000Z"]);
  });
});
