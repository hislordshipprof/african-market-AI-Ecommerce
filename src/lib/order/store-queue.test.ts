import { describe, expect, it } from "vitest";
import { describeQueue, storeAvailability } from "./store-queue";

const CHICAGO = "America/Chicago";
const HOURS = {
  monday: "9:00 AM - 8:00 PM",
  tuesday: "9:00 AM - 8:00 PM",
  wednesday: null,
  thursday: null,
  friday: "9:00 AM - 8:00 PM",
  saturday: null,
  sunday: null,
};

// Monday 16 Nov 2026 is CST (UTC-6), so 9:00 AM in Chicago is 15:00Z.
describe("describeQueue copy", () => {
  it("opens later today: names today's weekday and the opening and ready times", () => {
    expect(describeQueue(new Date("2026-11-16T15:00:00Z"), 30, CHICAGO)).toEqual({
      opensAt: "Mon 9:00 AM CT",
      readyAt: "9:30 AM",
    });
  });

  it("opens tomorrow: names tomorrow's weekday", () => {
    expect(describeQueue(new Date("2026-11-17T15:00:00Z"), 30, CHICAGO).opensAt).toBe("Tue 9:00 AM CT");
  });

  it("opens on a named weekday days away", () => {
    expect(describeQueue(new Date("2026-11-20T15:00:00Z"), 45, CHICAGO)).toEqual({
      opensAt: "Fri 9:00 AM CT",
      readyAt: "9:45 AM",
    });
  });

  it("names the store's own zone and clock whatever the shopper's zone is", () => {
    const opening = new Date("2026-11-16T15:00:00Z");
    expect(describeQueue(opening, 30, "America/New_York").opensAt).toBe("Mon 10:00 AM ET");
    expect(describeQueue(opening, 30, "America/Los_Angeles").opensAt).toBe("Mon 7:00 AM PT");
  });

  it("adds the weekday to the ready time when prep crosses midnight", () => {
    expect(describeQueue(new Date("2026-11-17T04:30:00Z"), 90, CHICAGO)).toEqual({
      opensAt: "Mon 10:30 PM CT",
      readyAt: "Tue 12:00 AM",
    });
  });

  it("feeds the copy from the next opening when the store is closed now", () => {
    // Monday 8:00 AM in Chicago, before opening.
    const now = new Date("2026-11-16T14:00:00Z");
    const availability = storeAvailability(HOURS, CHICAGO, now);
    expect(availability.kind).toBe("queued");
    if (availability.kind !== "queued") return;
    expect(describeQueue(availability.clockStartsAt, 30, CHICAGO).opensAt).toBe("Mon 9:00 AM CT");
  });
});
