import { describe, expect, it } from "vitest";
import { openStatus } from "./open-status";

const WEEKDAYS_9_TO_8 = {
  monday: "9:00 AM - 8:00 PM",
  tuesday: "9:00 AM - 8:00 PM",
  wednesday: "9:00 AM - 8:00 PM",
  thursday: "9:00 AM - 8:00 PM",
  friday: "9:00 AM - 8:00 PM",
  saturday: "9:30 AM - 8:00 PM",
  sunday: "Closed",
};

const at = (iso: string) => new Date(iso);

describe("openStatus", () => {
  it("says open now during the store's hours", () => {
    // Monday 16 Nov 2026, 10:00 in Houston (CST, UTC-6).
    expect(openStatus(WEEKDAYS_9_TO_8, "America/Chicago", at("2026-11-16T16:00:00Z"))).toEqual({ open: true, label: "Open now", detail: null });
  });

  it("before opening says the time it opens today, in the store's own clock", () => {
    // Monday 08:30 CST.
    expect(openStatus(WEEKDAYS_9_TO_8, "America/Chicago", at("2026-11-16T14:30:00Z"))).toEqual({ open: false, label: "Closed", detail: "Opens 9 AM" });
  });

  it("after closing says tomorrow, and a closed Sunday skips to Monday", () => {
    // Monday 21:00 CST.
    expect(openStatus(WEEKDAYS_9_TO_8, "America/Chicago", at("2026-11-17T03:00:00Z"))?.detail).toBe("Opens tomorrow 9 AM");
    // Friday 21:00 CST opens Saturday at 9:30.
    expect(openStatus(WEEKDAYS_9_TO_8, "America/Chicago", at("2026-11-21T03:00:00Z"))?.detail).toBe("Opens tomorrow 9:30 AM");
    // Saturday 21:00 CST: Sunday is closed.
    expect(openStatus(WEEKDAYS_9_TO_8, "America/Chicago", at("2026-11-22T03:00:00Z"))?.detail).toBe("Opens Mon 9 AM");
  });

  it("reads the same instant in each store's own timezone", () => {
    // 02:30 UTC on Tuesday 17 Nov is Monday 21:30 in New York (closed) and Monday 18:30 in Los Angeles (open).
    const instant = at("2026-11-17T02:30:00Z");
    expect(openStatus(WEEKDAYS_9_TO_8, "America/New_York", instant)).toMatchObject({ open: false, detail: "Opens tomorrow 9 AM" });
    expect(openStatus(WEEKDAYS_9_TO_8, "America/Los_Angeles", instant)).toMatchObject({ open: true, label: "Open now" });
  });

  it("follows the daylight saving change in autumn and spring", () => {
    // 13:30 UTC is 09:30 EDT on Saturday 31 Oct, but 08:30 EST on Monday 2 Nov, after the clocks went back.
    expect(openStatus(WEEKDAYS_9_TO_8, "America/New_York", at("2026-10-31T13:30:00Z"))?.open).toBe(true);
    expect(openStatus(WEEKDAYS_9_TO_8, "America/New_York", at("2026-11-02T13:30:00Z"))).toMatchObject({ open: false, detail: "Opens 9 AM" });
    // Monday 15 Mar 2027, the day after the clocks went forward: 9 AM EDT is 13:00 UTC, not 14:00.
    expect(openStatus(WEEKDAYS_9_TO_8, "America/New_York", at("2027-03-15T12:59:00Z"))).toMatchObject({ open: false, detail: "Opens 9 AM" });
    expect(openStatus(WEEKDAYS_9_TO_8, "America/New_York", at("2027-03-15T13:00:00Z"))?.open).toBe(true);
    // Sunday 14 Mar 2027 at 01:30 EST, half an hour before the change: Monday's 9 AM is still "tomorrow".
    expect(openStatus(WEEKDAYS_9_TO_8, "America/New_York", at("2027-03-14T06:30:00Z"))?.detail).toBe("Opens tomorrow 9 AM");
  });

  it("names the store's timezone when the shopper's clock is in another one", () => {
    // Monday 08:30 EST, seen from Chicago.
    const instant = at("2026-11-16T13:30:00Z");
    expect(openStatus(WEEKDAYS_9_TO_8, "America/New_York", instant, "America/Chicago")?.detail).toBe("Opens 9 AM EST");
    expect(openStatus(WEEKDAYS_9_TO_8, "America/New_York", instant, "America/Detroit")?.detail).toBe("Opens 9 AM");
  });

  it("is open with no hours set, as orders are (isStoreOpen); closed with no opening this week or a bad timezone", () => {
    expect(openStatus(null, "America/Chicago", at("2026-11-16T09:00:00Z"))).toEqual({ open: true, label: "Open now", detail: null });
    const shut = Object.fromEntries(Object.keys(WEEKDAYS_9_TO_8).map((day) => [day, "Closed"]));
    expect(openStatus(shut, "America/Chicago", at("2026-11-16T16:00:00Z"))).toEqual({ open: false, label: "Closed", detail: null });
    expect(openStatus(WEEKDAYS_9_TO_8, "Mars/Olympus", at("2026-11-16T16:00:00Z"))).toEqual({ open: false, label: "Closed", detail: null });
  });
});
