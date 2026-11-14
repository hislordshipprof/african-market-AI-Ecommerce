import { describe, expect, it } from "vitest";
import { pickupSlotsToday } from "../src/lib/order/pickup-slots";
import { handoffTimezone } from "./handoff-timezone";

describe("handoff E2E store timezone", () => {
  it("leaves a clock pickup slot today at every time of day", () => {
    const missing: string[] = [];
    // A winter day and a summer day, so both CST and CDT are covered.
    const minutes = [Date.UTC(2026, 10, 14), Date.UTC(2026, 6, 14)].flatMap((start) =>
      Array.from({ length: 24 * 12 }, (_, step) => start + step * 5 * 60_000),
    );
    for (const at of minutes) {
      const now = new Date(at);
      const store = { hours: null, timezone: handoffTimezone(now), prepTimeMinutes: 30, pickupEnabled: true };
      if (!pickupSlotsToday(store, now).some((slot) => slot.id !== "asap")) missing.push(now.toISOString());
    }
    expect(missing).toEqual([]);
  });
});
