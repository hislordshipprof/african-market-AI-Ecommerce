import { describe, expect, it } from "vitest";
import { pickupSlotsToday } from "../src/lib/order/pickup-slots";
import { HANDOFF_PREP_MINUTES, handoffTimezone } from "./handoff-timezone";

describe("handoff E2E store timezone", () => {
  // The "picks before the draft loads" E2E chooses the second time, so two must be left.
  it("leaves two clock pickup slots today at every time of day", () => {
    const missing: string[] = [];
    // A winter day and a summer day, so both CST and CDT are covered.
    const minutes = [Date.UTC(2026, 10, 14), Date.UTC(2026, 6, 14)].flatMap((start) =>
      Array.from({ length: 24 * 12 }, (_, step) => start + step * 5 * 60_000),
    );
    for (const at of minutes) {
      const now = new Date(at);
      const store = { hours: null, timezone: handoffTimezone(now), prepTimeMinutes: HANDOFF_PREP_MINUTES, pickupEnabled: true };
      if (pickupSlotsToday(store, now).filter((slot) => slot.id !== "asap").length < 2) missing.push(now.toISOString());
    }
    expect(missing).toEqual([]);
  });
});
