import { describe, expect, it } from "vitest";
import { formatInZone, formatListDate, money } from "./format";

const AT = new Date("2026-11-03T19:05:00.000Z");
const OPTIONS: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

describe("formatInZone", () => {
  it("formats in the store's zone", () => {
    expect(formatInZone(AT, "America/Los_Angeles", OPTIONS)).toBe("Nov 3, 11:05 AM");
  });

  it("falls back to New York for a zone Intl does not know instead of throwing", () => {
    expect(formatInZone(AT, "Mars/Olympus", OPTIONS)).toBe("Nov 3, 2:05 PM");
  });

  it("takes an ISO string as well as a Date", () => {
    expect(formatInZone(AT.toISOString(), "America/Chicago", OPTIONS)).toBe("Nov 3, 1:05 PM");
  });
});

describe("money", () => {
  // One USD format for shoppers and owners (#737): cents always shown, as receipts and Stripe show them.
  it.each([
    [0, "$0.00"],
    [5, "$0.05"],
    [500, "$5.00"],
    [1999, "$19.99"],
    [100000, "$1,000.00"],
    [-1999, "-$19.99"],
  ])("formats %i cents as %s", (cents, expected) => {
    expect(money(cents)).toBe(expected);
  });
});

describe("formatListDate", () => {
  // 03:30 UTC on Nov 4 is 9:30 PM on Nov 3 in Chicago.
  const NOW = new Date("2026-11-04T03:30:00.000Z");
  const CHICAGO = "America/Chicago";

  it("says Today for the store's current day", () => {
    expect(formatListDate(new Date("2026-11-03T14:00:00.000Z"), CHICAGO, NOW)).toBe("Today");
  });

  it("says Yesterday for the store's previous day, though its UTC date is the store's today", () => {
    // Nov 2, 11:30 PM in Chicago.
    expect(formatListDate(new Date("2026-11-03T05:30:00.000Z"), CHICAGO, NOW)).toBe("Yesterday");
  });

  it("gives the full date for anything older", () => {
    expect(formatListDate(new Date("2026-11-02T04:00:00.000Z"), CHICAGO, NOW)).toBe("Nov 1, 2026");
  });

  it("reads the day in the store's zone, not UTC", () => {
    // Nov 3, 9:00 PM in Chicago; its UTC date is Nov 4.
    expect(formatListDate("2026-11-04T03:00:00.000Z", CHICAGO, NOW)).toBe("Today");
  });
});
