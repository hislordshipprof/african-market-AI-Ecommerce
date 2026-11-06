import { describe, expect, it } from "vitest";
import { offerPickupSlots, storeLocalToUtc } from "./slots";

const hours = { mon: { open: "09:00", close: "17:00" } };

describe("offered slot ids stay valid across requests and respect opening, prep and store release", () => {
  it("keeps the 10:00 id when the request is five minutes later", () => {
    const first = offerPickupSlots({
      now: new Date("2026-11-02T14:00:00.000Z"),
      timeZone: "America/New_York",
      hours,
      prepMinutes: 30,
      windowMinutes: 10,
      pickupEnabled: true,
    });
    const later = offerPickupSlots({
      now: new Date("2026-11-02T14:05:00.000Z"),
      timeZone: "America/New_York",
      hours,
      prepMinutes: 30,
      windowMinutes: 10,
      pickupEnabled: true,
    });
    const ten = first.slots.find((slot) => slot.label.startsWith("10:00"));
    expect(ten?.id).toBe("2026-11-02T15:00:00.000Z");
    expect(later.slots.map((slot) => slot.id)).toContain(ten?.id);
    expect(first.slots[0]?.id).toBe("asap");
    expect(first.slots.at(-1)?.id).toBe("2026-11-02T21:30:00.000Z");
  });

  it("offers nothing when pickup is off, the store is closed, or the hours cannot be read", () => {
    expect(offerPickupSlots({
      now: new Date("2026-11-02T14:00:00.000Z"),
      timeZone: "America/New_York",
      hours,
      prepMinutes: 30,
      windowMinutes: 10,
      pickupEnabled: false,
    }).reason).toBe("pickup_off");
    expect(offerPickupSlots({
      now: new Date("2026-11-02T23:00:00.000Z"),
      timeZone: "America/New_York",
      hours,
      prepMinutes: 30,
      windowMinutes: 10,
      pickupEnabled: true,
    }).reason).toBe("closed");
    expect(offerPickupSlots({
      now: new Date("2026-11-02T14:00:00.000Z"),
      timeZone: "America/New_York",
      hours: { mon: "whenever" },
      prepMinutes: 30,
      windowMinutes: 10,
      pickupEnabled: true,
    }).reason).toBe("hours_unavailable");
  });

  it("offers slots after midnight when the shift closes overnight", () => {
    const offer = offerPickupSlots({
      now: new Date("2026-11-03T01:00:00.000Z"),
      timeZone: "America/New_York",
      hours: { mon: { open: "18:00", close: "02:00" } },
      prepMinutes: 0,
      windowMinutes: 10,
      pickupEnabled: true,
    });
    expect(offer.reason).toBe("ok");
    expect(offer.slots.some((slot) => slot.id !== "asap" && slot.id > "2026-11-03T05:00:00.000Z")).toBe(true);
  });

  it("skips a spring-forward gap and keeps the earlier fall-back instant", () => {
    expect(storeLocalToUtc(2026, 3, 8, 2, 30, "America/New_York")).toBeNull();
    const repeated = storeLocalToUtc(2026, 11, 1, 1, 30, "America/New_York");
    expect(repeated?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(storeLocalToUtc(2026, 3, 8, 3, 30, "America/New_York")?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(storeLocalToUtc(2026, 11, 1, 2, 30, "America/New_York")?.toISOString()).toBe("2026-11-01T07:30:00.000Z");
  });
});
