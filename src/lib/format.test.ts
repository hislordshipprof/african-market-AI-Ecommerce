import { describe, expect, it } from "vitest";
import { formatInZone } from "./format";

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
