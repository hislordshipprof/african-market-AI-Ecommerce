import { describe, it, expect, vi } from "vitest";
import { isStoreOpen, nextOpening, openMinutesDeadline } from "./store-hours";

const NY = "America/New_York";
const CHICAGO = "America/Chicago";

describe("isStoreOpen", () => {
  it("returns true during open hours (24h format, abbreviated day)", () => {
    const hours = { mon: { open: "09:00", close: "21:00" } };
    // Monday 2026-11-02 at 12:00 ET
    const now = new Date("2026-11-02T17:00:00Z"); // 12:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(true);
  });

  it("returns false outside hours (24h format, abbreviated day)", () => {
    const hours = { mon: { open: "09:00", close: "21:00" } };
    // Monday at 22:00 ET
    const now = new Date("2026-11-03T03:00:00Z"); // 22:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(false);
  });

  it("handles string range format with AM/PM and full day names", () => {
    const hours = {
      monday: "9:00 AM - 8:00 PM",
      tuesday: "9:00 AM - 8:00 PM",
    };
    // Monday at 14:00 ET
    const now = new Date("2026-11-02T19:00:00Z"); // 14:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(true);
  });

  it("returns false when store is closed on string range format", () => {
    const hours = {
      monday: "9:00 AM - 8:00 PM",
    };
    // Monday at 21:00 ET (9 PM)
    const now = new Date("2026-11-03T02:00:00Z"); // 21:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(false);
  });

  it("returns false for weekend when only weekday hours defined", () => {
    const hours = {
      mon: { open: "09:00", close: "21:00" },
      tue: { open: "09:00", close: "21:00" },
    };
    // Saturday at 12:00 ET
    const sat = new Date("2026-11-07T17:00:00Z");
    expect(isStoreOpen(hours, NY, sat)).toBe(false);
  });

  it("handles weekend hours (saturday)", () => {
    const hours = {
      saturday: "8:00 AM - 9:00 PM",
    };
    // Saturday at 15:00 ET
    const sat = new Date("2026-11-07T20:00:00Z");
    expect(isStoreOpen(hours, NY, sat)).toBe(true);
  });

  it("returns true when the store has no hours, or hours that are not an object", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(isStoreOpen(null, NY)).toBe(true);
    expect(isStoreOpen([], NY)).toBe(true);
    expect(isStoreOpen("9-5", NY)).toBe(true);
    spy.mockRestore();
  });

  it("returns false at exactly closing time (boundary)", () => {
    const hours = { mon: { open: "09:00", close: "20:00" } };
    // Monday at exactly 20:00 ET
    const now = new Date("2026-11-03T01:00:00Z"); // 20:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(false);
  });

  it("returns true at exactly opening time (boundary)", () => {
    const hours = { mon: { open: "09:00", close: "20:00" } };
    // Monday at exactly 09:00 ET
    const now = new Date("2026-11-02T14:00:00Z"); // 09:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(true);
  });

  // Finding 6/7: timezone tests
  it("Houston (America/Chicago) at 2026-11-03T01:00Z is Monday 19:00 CT (open)", () => {
    const hours = { mon: { open: "08:00", close: "22:00" } };
    // 2026-11-03T01:00Z = Mon 19:00 CT (CDT ended Nov 1)
    const now = new Date("2026-11-03T01:00:00Z");
    expect(isStoreOpen(hours, CHICAGO, now)).toBe(true);
  });

  it("Houston store closed before open at same UTC", () => {
    const hours = { mon: { open: "20:00", close: "22:00" } };
    // 2026-11-03T01:00Z = Mon 19:00 CT — before 20:00 open
    const now = new Date("2026-11-03T01:00:00Z");
    expect(isStoreOpen(hours, CHICAGO, now)).toBe(false);
  });

  // Finding 6/7: overnight hours tests
  it("overnight window 20:00–02:00 at 23:00 (open)", () => {
    const hours = { mon: { open: "20:00", close: "02:00" } };
    // Monday 23:00 ET
    const now = new Date("2026-11-03T04:00:00Z"); // 23:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(true);
  });

  it("overnight window 20:00–02:00 at 01:00 next day (still open from yesterday)", () => {
    const hours = { mon: { open: "20:00", close: "02:00" } };
    // Tuesday 01:00 ET — still in Monday's overnight window
    const now = new Date("2026-11-03T06:00:00Z"); // Tue 01:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(true);
  });

  it("overnight window 20:00–02:00 at 03:00 next day (closed)", () => {
    const hours = { mon: { open: "20:00", close: "02:00" } };
    // Tuesday 03:00 ET — after Monday's overnight closes
    const now = new Date("2026-11-03T08:00:00Z"); // Tue 03:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(false);
  });

  it("overnight window 20:00–02:00 at 19:00 (before open, closed)", () => {
    const hours = { mon: { open: "20:00", close: "02:00" } };
    // Monday 19:00 ET
    const now = new Date("2026-11-03T00:00:00Z"); // Mon 19:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(false);
  });

  it("K4: Houston store (America/Chicago) at 08:30 local is closed when store opens 09:00", () => {
    const hours = { mon: { open: "09:00", close: "20:00" } };
    // Mon 2026-11-02, 08:30 CST = 14:30 UTC (DST ended Nov 1)
    const at0830central = new Date("2026-11-02T14:30:00Z");
    // With correct Central timezone: 08:30 < 09:00 → closed
    expect(isStoreOpen(hours, CHICAGO, at0830central)).toBe(false);
    // Same UTC instant in Eastern = 09:30 → would incorrectly show open
    expect(isStoreOpen(hours, NY, at0830central)).toBe(true);
    // At 09:00 CST (15:00 UTC): now open
    const at0900central = new Date("2026-11-02T15:00:00Z");
    expect(isStoreOpen(hours, CHICAGO, at0900central)).toBe(true);
  });

  it("returns false on invalid timezone instead of throwing (A4 fix)", () => {
    const hours = { mon: { open: "09:00", close: "21:00" } };
    const now = new Date("2026-11-02T17:00:00Z");
    expect(isStoreOpen(hours, "Not/A_Real_Zone", now)).toBe(false);
  });

  // Monday 2026-11-02 12:00 in Chicago (CST, UTC-6) and 17:00 UTC = 12:00 ET.
  const mondayNoonChicago = new Date("2026-11-02T18:00:00Z");
  const mondayNoonEastern = new Date("2026-11-02T17:00:00Z");
  const mondayTenPmEastern = new Date("2026-11-03T03:00:00Z");

  it.each([
    ["9:00 AM - 9:00 PM", mondayNoonEastern, true],
    ["09:00-21:00", mondayTenPmEastern, false],
    ["9pm-2am", new Date("2026-11-03T04:00:00Z"), true],
    ["9pm-2am", new Date("2026-11-03T08:00:00Z"), false],
  ])("parses %s at %s → open=%s", (range, now, open) => {
    expect(isStoreOpen({ monday: range }, now === mondayNoonChicago ? CHICAGO : NY, now)).toBe(open);
  });

  it("treats an explicit Closed day as closed", () => {
    const sunday = "Closed";
    const now = new Date("2026-11-08T20:00:00Z");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      isStoreOpen({ monday: "10:00 AM - 7:00 PM", sunday }, NY, now),
    ).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("treats { closed: true } as closed for that day", () => {
    expect(
      isStoreOpen(
        { monday: "10:00 AM - 7:00 PM", sunday: { closed: true } },
        NY,
        new Date("2026-11-08T20:00:00Z"),
      ),
    ).toBe(false);
  });

  it("unparseable hours log and count as open", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(isStoreOpen({ monday: "all day" }, NY, mondayNoonEastern)).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a day whose open equals its close is closed and does not open the next morning", () => {
    const tue0200 = new Date("2026-11-03T08:00:00Z");
    const tue0900 = new Date("2026-11-03T15:00:00Z");
    const mon1700 = new Date("2026-11-02T23:00:00Z");
    const mon2200 = new Date("2026-11-03T04:00:00Z");
    const tue0800 = new Date("2026-11-03T14:00:00Z");

    const midnightEqual = { tuesday: { open: "00:00", close: "00:00" } };
    expect(isStoreOpen(midnightEqual, CHICAGO, tue0200)).toBe(false);
    expect(isStoreOpen(midnightEqual, CHICAGO, tue0900)).toBe(false);

    const stringEqual = { monday: "9:00 AM - 9:00 AM", tuesday: "Closed" };
    expect(isStoreOpen(stringEqual, CHICAGO, mon1700)).toBe(false);
    expect(isStoreOpen(stringEqual, CHICAGO, tue0800)).toBe(false);

    const objectEqual = { monday: { open: "09:00", close: "09:00" } };
    expect(isStoreOpen(objectEqual, CHICAGO, mon1700)).toBe(false);

    const mixedTextEqual = { monday: "21:00 - 9:00 PM", tuesday: "Closed" };
    expect(isStoreOpen(mixedTextEqual, CHICAGO, mon2200)).toBe(false);
    expect(isStoreOpen(mixedTextEqual, CHICAGO, tue0800)).toBe(false);
  });

  it("an equal range today preserves yesterday's valid overnight window", () => {
    const hours = {
      monday: "20:00-02:00",
      tuesday: { open: "09:00", close: "09:00" },
    };
    expect(isStoreOpen(hours, CHICAGO, new Date("2026-11-03T07:00:00Z"))).toBe(true);
    expect(isStoreOpen(hours, CHICAGO, new Date("2026-11-03T08:00:00Z"))).toBe(false);
    expect(isStoreOpen(hours, CHICAGO, new Date("2026-11-03T09:00:00Z"))).toBe(false);
  });

  it("midnight honors same-day and overnight boundaries", () => {
    const midnight = new Date("2026-11-03T06:00:00Z");
    const halfPast = new Date("2026-11-03T06:30:00Z");
    expect(
      isStoreOpen({ tuesday: { open: "00:00", close: "01:00" } }, CHICAGO, midnight),
    ).toBe(true);
    expect(
      isStoreOpen({ tuesday: { open: "00:00", close: "01:00" } }, CHICAGO, halfPast),
    ).toBe(true);
    expect(
      isStoreOpen({ monday: { open: "20:00", close: "02:00" } }, CHICAGO, midnight),
    ).toBe(true);
    expect(
      isStoreOpen({ monday: { open: "20:00", close: "02:00" } }, CHICAGO, halfPast),
    ).toBe(true);
    expect(isStoreOpen({ monday: "23:00-00:00" }, CHICAGO, midnight)).toBe(false);
  });
});

describe("nextOpening and openMinutesDeadline", () => {
  it("next opening and the open-minute deadlines agree with isStoreOpen across overnight, DST and the closing minute", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const at = (iso: string) => new Date(iso);
    const iso = (d: Date | null) => d?.toISOString() ?? null;
    const weekdays = {
      mon: { open: "09:00", close: "17:00" },
      tue: { open: "09:00", close: "17:00" },
      wed: { open: "09:00", close: "17:00" },
      thu: { open: "09:00", close: "17:00" },
      fri: { open: "09:00", close: "17:00" },
    };

    // AC1: Tue 20:00 CST opens Wed 09:00 CST; 15 and 30 open minutes after that.
    expect(iso(nextOpening(weekdays, CHICAGO, at("2026-11-04T02:00:00Z")))).toBe("2026-11-04T15:00:00.000Z");
    expect(iso(openMinutesDeadline(weekdays, CHICAGO, at("2026-11-04T15:00:00Z"), 15))).toBe("2026-11-04T15:15:00.000Z");
    expect(iso(openMinutesDeadline(weekdays, CHICAGO, at("2026-11-04T15:00:00Z"), 30))).toBe("2026-11-04T15:30:00.000Z");

    // E1: overnight window, open at 01:00, next opening 22:00 the same day from 03:00.
    const overnight = { monday: "10:00 PM - 2:00 AM", tuesday: "10:00 PM - 2:00 AM" };
    expect(iso(nextOpening(overnight, CHICAGO, at("2026-11-03T07:00:00Z")))).toBe("2026-11-03T07:00:00.000Z");
    expect(iso(nextOpening(overnight, CHICAGO, at("2026-11-03T09:00:00Z")))).toBe("2026-11-04T04:00:00.000Z");

    // E2 spring-forward (2026-03-08): 02:30 does not exist, so 03:00 CDT is the first open minute.
    const spring = { sunday: { open: "02:30", close: "10:00" } };
    expect(iso(nextOpening(spring, CHICAGO, at("2026-03-08T06:00:00Z")))).toBe("2026-03-08T08:00:00.000Z");
    expect(iso(openMinutesDeadline(spring, CHICAGO, at("2026-03-08T08:00:00Z"), 30))).toBe("2026-03-08T08:30:00.000Z");
    // E2 fall-back (2026-11-01): the first 01:00 CDT opens; the repeated hour counts real minutes.
    const fall = { sunday: { open: "01:00", close: "03:00" } };
    expect(iso(nextOpening(fall, CHICAGO, at("2026-11-01T04:00:00Z")))).toBe("2026-11-01T06:00:00.000Z");
    expect(iso(openMinutesDeadline(fall, CHICAGO, at("2026-11-01T06:00:00Z"), 90))).toBe("2026-11-01T07:30:00.000Z");

    // E6: 17:00 is closed (next opening Wed 09:00); 16:59 is open with one minute left that day.
    expect(iso(nextOpening(weekdays, CHICAGO, at("2026-11-03T23:00:00Z")))).toBe("2026-11-04T15:00:00.000Z");
    expect(iso(nextOpening(weekdays, CHICAGO, at("2026-11-03T22:59:00Z")))).toBe("2026-11-03T22:59:00.000Z");
    expect(iso(openMinutesDeadline(weekdays, CHICAGO, at("2026-11-03T22:59:00Z"), 15))).toBe("2026-11-04T15:14:00.000Z");
    // E25: 16:59:45 gets 15 seconds that day.
    expect(iso(openMinutesDeadline(weekdays, CHICAGO, at("2026-11-03T22:59:45Z"), 15))).toBe("2026-11-04T15:14:45.000Z");

    // Straddling the 20:00 close: placed 19:50 alerts 09:05 and cancels 09:20; 19:59:30 alerts 09:14:30.
    const daily = { monday: "09:00-20:00", tuesday: "09:00-20:00", wednesday: "09:00-20:00" };
    expect(iso(openMinutesDeadline(daily, CHICAGO, at("2026-11-04T01:50:00Z"), 15))).toBe("2026-11-04T15:05:00.000Z");
    expect(iso(openMinutesDeadline(daily, CHICAGO, at("2026-11-04T01:50:00Z"), 30))).toBe("2026-11-04T15:20:00.000Z");
    expect(iso(openMinutesDeadline(daily, CHICAGO, at("2026-11-04T01:59:30Z"), 15))).toBe("2026-11-04T15:14:30.000Z");
    // A mid-minute order at an open store keeps exact seconds.
    expect(iso(openMinutesDeadline(daily, CHICAGO, at("2026-11-03T18:03:27Z"), 15))).toBe("2026-11-03T18:18:27.000Z");
    expect(iso(openMinutesDeadline(daily, CHICAGO, at("2026-11-03T18:03:27Z"), 30))).toBe("2026-11-03T18:33:27.000Z");

    // A schedule that never opens yields null, without throwing or hanging.
    const allClosed = { mon: "Closed", tue: { closed: true }, wed: "Closed", thu: "Closed", fri: "Closed", sat: "Closed", sun: "Closed" };
    for (const never of [{}, allClosed]) {
      expect(nextOpening(never, CHICAGO, at("2026-11-04T02:00:00Z"))).toBeNull();
      expect(openMinutesDeadline(never, CHICAGO, at("2026-11-04T02:00:00Z"), 15)).toBeNull();
    }
    // Each answer agrees with isStoreOpen at the instant it returns, and one minute before.
    expect(isStoreOpen(weekdays, CHICAGO, at("2026-11-04T15:00:00Z"))).toBe(true);
    expect(isStoreOpen(weekdays, CHICAGO, at("2026-11-04T14:59:00Z"))).toBe(false);
    expect(isStoreOpen(spring, CHICAGO, at("2026-03-08T08:00:00Z"))).toBe(true);
    expect(isStoreOpen(spring, CHICAGO, at("2026-03-08T07:59:00Z"))).toBe(false);
    spy.mockRestore();
  });
});
