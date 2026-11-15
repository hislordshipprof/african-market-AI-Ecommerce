import { describe, expect, it } from "vitest";
import { pickupSlotsToday } from "./pickup-slots";

const NY = "America/New_York";
const WEEK_9_TO_9 = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [day, { open: "09:00", close: "21:00" }]),
);

function ids(slots: { id: string }[]) {
  return slots.map((slot) => slot.id);
}

describe("pickupSlotsToday", () => {
  it("offers ASAP and 30-minute slots from now plus prep time until closing, in store time", () => {
    // Wed 2026-11-11 14:10 EST.
    const slots = pickupSlotsToday({ hours: WEEK_9_TO_9, timezone: NY, prepTimeMinutes: 30, pickupEnabled: true }, new Date("2026-11-11T19:10:00Z"));
    expect(slots[0]).toEqual({ id: "asap", label: "As soon as it is ready" });
    expect(slots[1]).toEqual({ id: "2026-11-11T20:00:00.000Z", label: "3:00 PM EST" });
    expect(slots.at(-1)?.label).toBe("8:30 PM EST");
    expect(slots).toHaveLength(1 + 12);
  });

  it("uses the store's zone, not the server's", () => {
    const slots = pickupSlotsToday(
      { hours: WEEK_9_TO_9, timezone: "America/Los_Angeles", prepTimeMinutes: 15, pickupEnabled: true },
      new Date("2026-11-11T19:10:00Z"),
    );
    expect(slots[1]).toEqual({ id: "2026-11-11T19:30:00.000Z", label: "11:30 AM PST" });
  });

  it("a store closed now offers its next opening today, without ASAP", () => {
    // 07:00 EST, opens 09:00.
    const slots = pickupSlotsToday({ hours: WEEK_9_TO_9, timezone: NY, prepTimeMinutes: 30, pickupEnabled: true }, new Date("2026-11-11T12:00:00Z"));
    expect(ids(slots)).not.toContain("asap");
    expect(slots[0].label).toBe("9:30 AM EST");
  });

  it("offers nothing when the store does not open again today, when prep time crosses closing, or pickup is off", () => {
    const store = { hours: WEEK_9_TO_9, timezone: NY, prepTimeMinutes: 30, pickupEnabled: true };
    expect(pickupSlotsToday(store, new Date("2026-11-12T02:30:00Z"))).toEqual([]); // 21:30 EST
    expect(pickupSlotsToday(store, new Date("2026-11-12T01:45:00Z"))).toEqual([]); // 20:45 EST
    expect(pickupSlotsToday({ ...store, pickupEnabled: false }, new Date("2026-11-11T19:10:00Z"))).toEqual([]);
    expect(pickupSlotsToday({ ...store, timezone: "Not/AZone" }, new Date("2026-11-11T19:10:00Z"))).toEqual([]);
  });

  it("an overnight store offers slots until midnight, not into tomorrow", () => {
    const overnight = Object.fromEntries(
      ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [day, { open: "18:00", close: "02:00" }]),
    );
    // 23:00 EST.
    const slots = pickupSlotsToday({ hours: overnight, timezone: NY, prepTimeMinutes: 20, pickupEnabled: true }, new Date("2026-11-12T04:00:00Z"));
    expect(slots.map((slot) => slot.label)).toEqual(["As soon as it is ready", "11:30 PM EST"]);
  });

  it("a DST day has 23 hours and labels each side of the change", () => {
    // Sun 2026-03-08 00:10 EST; always open.
    const slots = pickupSlotsToday({ hours: null, timezone: NY, prepTimeMinutes: 30, pickupEnabled: true }, new Date("2026-03-08T05:10:00Z"));
    expect(slots[1].label).toBe("1:00 AM EST");
    expect(slots[3].label).toBe("3:00 AM EDT");
    expect(slots.at(-1)?.label).toBe("11:30 PM EDT");
    expect(slots).toHaveLength(1 + 44);
  });
});
