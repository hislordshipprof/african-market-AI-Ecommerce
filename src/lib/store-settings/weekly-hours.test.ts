import { describe, expect, it } from "vitest";
import { isStoreOpen, nextOpening } from "../order/store-hours";
import { DEFAULT_WEEK, readWeeklyHours, weeklyHoursError, writeWeeklyHours } from "./weekly-hours";

// A Monday, 2 pm in Chicago.
const MONDAY_2PM = new Date("2026-11-16T20:00:00Z");

describe("weekly hours editor (#786)", () => {
  it("reads the stored shape and writes it back unchanged, so the storefront hours block keeps rendering", () => {
    const stored = {
      monday: "9:00 AM - 8:00 PM",
      tuesday: "9:00 AM - 8:00 PM",
      wednesday: "9:00 AM - 8:00 PM",
      thursday: "9:00 AM - 8:00 PM",
      friday: "9:00 AM - 9:00 PM",
      saturday: "8:00 AM - 9:00 PM",
      sunday: "Closed",
    };
    const read = readWeeklyHours(stored);
    expect(read?.unreadable).toEqual([]);
    expect(read?.week.monday).toEqual({ closed: false, open: "09:00", close: "20:00" });
    expect(read?.week.sunday.closed).toBe(true);
    expect(writeWeeklyHours(read!.week)).toEqual(stored);
  });

  it("reads every shape checkout accepts: short keys, 24-hour ranges and objects; a missing day is closed", () => {
    const read = readWeeklyHours({ mon: "22:00-02:00", tue: { open: "9am", close: "5pm" }, wed: { closed: true } });
    expect(read?.week.monday).toEqual({ closed: false, open: "22:00", close: "02:00" });
    expect(read?.week.tuesday).toEqual({ closed: false, open: "09:00", close: "17:00" });
    expect(read?.week.wednesday.closed).toBe(true);
    expect(read?.week.thursday.closed).toBe(true);
    expect(read?.unreadable).toEqual([]);
  });

  it("names a day it cannot read instead of dropping it silently; no hours reads as null", () => {
    expect(readWeeklyHours({ monday: "mornings" })?.unreadable).toEqual(["monday"]);
    expect(readWeeklyHours(null)).toBeNull();
    expect(readWeeklyHours([])).toBeNull();
  });

  it("what it writes is what checkout reads: open Monday afternoon, closed Sunday", () => {
    const hours = writeWeeklyHours({ ...DEFAULT_WEEK, monday: { closed: false, open: "09:00", close: "17:30" }, sunday: { closed: true, open: "09:00", close: "17:00" } });
    expect(hours.monday).toBe("9:00 AM - 5:30 PM");
    expect(isStoreOpen(hours, "America/Chicago", MONDAY_2PM)).toBe(true);
    expect(nextOpening(hours, "America/Chicago", MONDAY_2PM)).not.toBeNull();
  });

  it("refuses a day that opens and closes at the same time and a week with every day closed; overnight is fine", () => {
    expect(weeklyHoursError({ ...DEFAULT_WEEK, friday: { closed: false, open: "09:00", close: "09:00" } })).toMatch(/Friday/);
    expect(weeklyHoursError({ ...DEFAULT_WEEK, friday: { closed: false, open: "22:00", close: "02:00" } })).toBeNull();
    const shut = Object.fromEntries(Object.entries(DEFAULT_WEEK).map(([day, h]) => [day, { ...h, closed: true }])) as typeof DEFAULT_WEEK;
    expect(weeklyHoursError(shut)).toMatch(/at least one day/);
  });
});
