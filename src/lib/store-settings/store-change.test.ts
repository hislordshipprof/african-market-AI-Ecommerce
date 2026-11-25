import { describe, expect, it } from "vitest";
import { activeStoreChanges, keepOneOffDays, storeChangeBefore, storeChangeEndsAt, storeChangeError, storeChangeText } from "./store-change";

const NY = "America/New_York";
// Tuesday Nov 24 2026, 3:00 PM in New York (UTC-5).
const NOW = new Date("2026-11-24T20:00:00Z");

describe("storeChangeError (#819)", () => {
  it("takes a day from today to 13 days ahead in the store's zone, and nothing else", () => {
    const closed = (date: string) => storeChangeError({ kind: "day_hours", date, closed: true }, NY, NOW);
    expect(closed("2026-11-24")).toBeNull();
    expect(closed("2026-12-07")).toBeNull();
    expect(closed("2026-11-23")).not.toBeNull();
    expect(closed("2026-12-08")).not.toBeNull();
    expect(closed("2026-02-30")).not.toBeNull();
    // 11:30 PM Nov 24 in New York is already Nov 25 in UTC; today is still the 24th there.
    expect(storeChangeError({ kind: "day_hours", date: "2026-11-24", closed: true }, NY, new Date("2026-11-25T04:30:00Z"))).toBeNull();
  });

  it("needs opening before closing on the same day", () => {
    const hours = (open: string, close: string) => storeChangeError({ kind: "day_hours", date: "2026-11-25", closed: false, open, close }, NY, NOW);
    expect(hours("09:00", "18:00")).toBeNull();
    expect(hours("18:00", "09:00")).not.toBeNull();
    expect(hours("09:00", "09:00")).not.toBeNull();
    expect(hours("9", "late")).not.toBeNull();
  });

  it("takes a pause that ends after now and at most 7 days ahead", () => {
    const pause = (until: string) => storeChangeError({ kind: "delivery_pause", until }, NY, NOW);
    expect(pause("2026-11-25T04:59:00Z")).toBeNull();
    expect(pause("2026-12-01T20:00:00Z")).toBeNull();
    expect(pause("2026-11-24T19:00:00Z")).not.toBeNull();
    expect(pause("2026-12-01T20:01:00Z")).not.toBeNull();
    expect(pause("not a time")).not.toBeNull();
  });
});

describe("storeChangeEndsAt and storeChangeText (#819)", () => {
  it("a one-off day ends at the store's midnight after it; a pause at its own end", () => {
    expect(storeChangeEndsAt({ kind: "day_hours", date: "2026-11-25", closed: true }, NY)).toEqual(new Date("2026-11-26T05:00:00Z"));
    expect(storeChangeEndsAt({ kind: "delivery_pause", until: "2026-11-25T04:59:00Z" }, NY)).toEqual(new Date("2026-11-25T04:59:00Z"));
  });

  it("says the day, the hours and that the week stays the same", () => {
    expect(storeChangeText({ kind: "day_hours", date: "2026-11-25", closed: false, open: "09:00", close: "18:00" }, NY, NOW))
      .toBe("Wed Nov 25: open 9:00 AM to 6:00 PM (one day only). Your weekly hours stay the same.");
    expect(storeChangeText({ kind: "day_hours", date: "2026-11-26", closed: true }, NY, NOW))
      .toBe("Closed all day Thu Nov 26 (one day only). Your weekly hours stay the same.");
  });

  it("says when delivery comes back, as today or the day", () => {
    expect(storeChangeText({ kind: "delivery_pause", until: "2026-11-25T04:59:00Z" }, NY, NOW))
      .toBe("Delivery paused until 11:59 PM today, Tue Nov 24. Pickup stays open.");
    expect(storeChangeText({ kind: "delivery_pause", until: "2026-11-25T14:00:00Z" }, NY, NOW))
      .toBe("Delivery paused until 9:00 AM Wed Nov 25. Pickup stays open.");
  });
});

describe("storeChangeBefore (#819)", () => {
  const store = {
    hours: { wednesday: "9:00 AM - 8:00 PM", thu: { open: "09:00", close: "17:00" }, dates: { "2026-11-25": "9:00 AM - 6:00 PM" } },
    deliveryPausedUntil: null,
    timezone: NY,
  };

  it("reads the stored one-off and the weekday's weekly hours for that date", () => {
    expect(storeChangeBefore(store, { kind: "day_hours", date: "2026-11-25", closed: true })).toEqual({ date: "9:00 AM - 6:00 PM", weekly: "9:00 AM - 8:00 PM" });
    expect(storeChangeBefore(store, { kind: "day_hours", date: "2026-11-26", closed: true })).toEqual({ date: null, weekly: '{"open":"09:00","close":"17:00"}' });
    expect(storeChangeBefore({ ...store, hours: null }, { kind: "day_hours", date: "2026-11-26", closed: true })).toEqual({ date: null, weekly: null });
  });

  it("reads the current pause end", () => {
    const until = new Date("2026-11-25T04:59:00Z");
    expect(storeChangeBefore(store, { kind: "delivery_pause", until: until.toISOString() })).toEqual({ deliveryPausedUntil: null });
    expect(storeChangeBefore({ ...store, deliveryPausedUntil: until }, { kind: "delivery_pause", until: until.toISOString() }))
      .toEqual({ deliveryPausedUntil: "2026-11-25T04:59:00.000Z" });
  });
});

describe("keepOneOffDays (#819)", () => {
  const previous = { monday: "Closed", dates: { "2026-11-23": "Closed", "2026-11-24": "9:00 AM - 1:00 PM", "2026-11-30": "Closed" } };

  it("carries today's and later one-off days onto newly saved weekly hours, dropping past ones", () => {
    expect(keepOneOffDays({ monday: "9:00 AM - 8:00 PM" }, previous, NY, NOW)).toEqual({
      monday: "9:00 AM - 8:00 PM",
      dates: { "2026-11-24": "9:00 AM - 1:00 PM", "2026-11-30": "Closed" },
    });
  });

  it("leaves hours alone when there is nothing to keep, or no weekly hours were saved", () => {
    expect(keepOneOffDays({ monday: "9:00 AM - 8:00 PM" }, { monday: "Closed", dates: { "2026-11-23": "Closed" } }, NY, NOW)).toEqual({ monday: "9:00 AM - 8:00 PM" });
    expect(keepOneOffDays({ monday: "9:00 AM - 8:00 PM" }, null, NY, NOW)).toEqual({ monday: "9:00 AM - 8:00 PM" });
    expect(keepOneOffDays(null, previous, NY, NOW)).toBeNull();
  });
});

describe("activeStoreChanges (#819)", () => {
  it("lists today's and later one-off days in date order, then a pause that has not ended", () => {
    const store = {
      hours: { monday: "Closed", dates: { "2026-11-26": "Closed", "2026-11-23": "Closed", "2026-11-25": "9:00 AM - 6:00 PM" } },
      deliveryPausedUntil: new Date("2026-11-25T04:59:00Z"),
      timezone: NY,
    };
    expect(activeStoreChanges(store, NOW)).toEqual([
      { which: { date: "2026-11-25" }, text: "Wed Nov 25: open 9:00 AM - 6:00 PM" },
      { which: { date: "2026-11-26" }, text: "Thu Nov 26: closed all day" },
      { which: { deliveryPause: true }, text: "Delivery paused until 11:59 PM today, Tue Nov 24" },
    ]);
    expect(activeStoreChanges({ ...store, deliveryPausedUntil: new Date("2026-11-24T19:00:00Z") }, NOW)).toHaveLength(2);
    expect(activeStoreChanges({ hours: null, deliveryPausedUntil: null, timezone: NY }, NOW)).toEqual([]);
  });
});
