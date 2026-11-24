import { describe, expect, it } from "vitest";
import { pickupChipLabel } from "./pickup-chip-label";

const WEEKDAYS_9_TO_8 = {
  monday: "9:00 AM - 8:00 PM",
  tuesday: "9:00 AM - 8:00 PM",
  wednesday: "9:00 AM - 8:00 PM",
  thursday: "9:00 AM - 8:00 PM",
  friday: "9:00 AM - 8:00 PM",
  saturday: "9:00 AM - 8:00 PM",
  sunday: "Closed",
};
const ALWAYS_CLOSED = Object.fromEntries(Object.keys(WEEKDAYS_9_TO_8).map((day) => [day, "Closed"]));

describe("header pickup chip (#763 AC3)", () => {
  it("promises the pickup time only while the store is open", () => {
    // Monday 16 Nov 2026, 10:00 in Houston.
    expect(pickupChipLabel(30, WEEKDAYS_9_TO_8, "America/Chicago", new Date("2026-11-16T16:00:00Z"))).toBe("Pickup · 30 min");
  });

  it("says when a closed store opens instead of a pickup time", () => {
    // Monday 21:00 CST.
    expect(pickupChipLabel(30, WEEKDAYS_9_TO_8, "America/Chicago", new Date("2026-11-17T03:00:00Z"))).toBe("Opens tomorrow 9 AM");
  });

  it("says closed when the store never opens in the week ahead", () => {
    expect(pickupChipLabel(30, ALWAYS_CLOSED, "America/Chicago", new Date("2026-11-16T16:00:00Z"))).toBe("Closed");
  });
});
