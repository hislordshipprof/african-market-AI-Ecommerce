import { describe, expect, it, vi } from "vitest";
import { formatInZone, formatListDate, formatListTime, formatUsPhone, mapsUrl, money, telHref } from "./format";

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

  it("does not depend on how the browser parses a date string", () => {
    // Engines differ on "MM/DD/YYYY"; one that read it as day/month would put Nov 3 in March.
    const parse = vi.spyOn(Date, "parse").mockReturnValue(Number.NaN);
    try {
      expect(formatListDate(new Date("2026-11-03T14:00:00.000Z"), CHICAGO, NOW)).toBe("Today");
      expect(formatListDate(new Date("2026-11-03T05:30:00.000Z"), CHICAGO, NOW)).toBe("Yesterday");
    } finally {
      parse.mockRestore();
    }
  });

  it("counts Yesterday across a month and a year boundary", () => {
    // Jan 1, 10:00 AM in Chicago; Dec 31, 10:00 AM the day before.
    const newYear = new Date("2027-01-01T16:00:00.000Z");
    expect(formatListDate(new Date("2026-12-31T16:00:00.000Z"), CHICAGO, newYear)).toBe("Yesterday");
    expect(formatListDate(new Date("2026-12-30T16:00:00.000Z"), CHICAGO, newYear)).toBe("Dec 30, 2026");
  });
});

describe("formatListTime", () => {
  const NOW = new Date("2026-11-04T03:30:00.000Z");

  it("joins the list day to the store's labelled clock time", () => {
    expect(formatListTime(new Date("2026-11-03T19:05:00.000Z"), "America/Chicago", NOW)).toBe("Today, 1:05 PM CST");
    expect(formatListTime(new Date("2026-11-01T19:05:00.000Z"), "America/Chicago", NOW)).toBe("Nov 1, 2026, 1:05 PM CST");
  });
});

describe("formatUsPhone", () => {
  it("formats ten digits however they were typed", () => {
    expect(formatUsPhone("2025550100")).toBe("(202) 555-0100");
    expect(formatUsPhone("202.555.0100")).toBe("(202) 555-0100");
    expect(formatUsPhone(" 202-555-0100 ")).toBe("(202) 555-0100");
  });

  it("drops the US country code", () => {
    expect(formatUsPhone("+1 202 555 0100")).toBe("(202) 555-0100");
    expect(formatUsPhone("12025550100")).toBe("(202) 555-0100");
  });

  it("leaves a number that is not a US number as typed", () => {
    expect(formatUsPhone("+234 803 123 4567")).toBe("+234 803 123 4567");
    expect(formatUsPhone("555-0100")).toBe("555-0100");
  });
});

describe("telHref", () => {
  it("dials a US number with its country code however it was typed (#751)", () => {
    expect(telHref("(202) 555-0100")).toBe("tel:+12025550100");
    expect(telHref("+1 202 555 0100")).toBe("tel:+12025550100");
    expect(telHref("12025550100")).toBe("tel:+12025550100");
  });

  it("dials any other number as typed, without spaces", () => {
    expect(telHref("+44 20 7946 0958")).toBe("tel:+442079460958");
  });
});

describe("mapsUrl", () => {
  it("opens directions to the address (#751)", () => {
    expect(mapsUrl("7500 Bellfort St, Houston, TX 77061")).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=7500%20Bellfort%20St%2C%20Houston%2C%20TX%2077061",
    );
  });
});
