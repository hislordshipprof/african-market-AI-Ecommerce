import { describe, expect, it } from "vitest";
import { computeConfidence, type ConfidenceEvent } from "./confidence";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
const event = (type: string, delta: number, days: number): ConfidenceEvent => ({ type, delta, createdAt: daysAgo(days) });
const counted = (createdDaysAgo: number, qty: number | null = 10) => ({
  createdAt: daysAgo(createdDaysAgo),
  stockMode: "counted",
  qty,
});

describe("computeConfidence", () => {
  it("idle decay crosses 0.6 by day 7, stops at 0.30, and a recount restores it", () => {
    // No events: the age comes from createdAt.
    expect(computeConfidence(counted(0), [], NOW)).toBeCloseTo(1, 5);
    expect(computeConfidence(counted(6), [], NOW)).toBeGreaterThanOrEqual(0.6);
    expect(computeConfidence(counted(7), [], NOW)).toBeLessThan(0.6);
    expect(computeConfidence(counted(90), [], NOW)).toBeGreaterThanOrEqual(0.3);

    // Only reservation movement must not count as a confirmation.
    const reservationsOnly = [event("reservation", -3, 0), event("reservation_release", 3, 0)];
    expect(computeConfidence(counted(8), reservationsOnly, NOW)).toBeLessThan(0.6);

    // Each kind of confirmation today restores it, even a day old and on a listing that sells fast.
    for (const type of ["recount", "restock", "adjust"]) {
      expect(computeConfidence(counted(90), [event(type, 5, 0)], NOW)).toBeGreaterThanOrEqual(0.9);
      expect(
        computeConfidence(counted(90, 1), [event("sale", -300, 2), event(type, 5, 0.99)], NOW),
      ).toBeGreaterThanOrEqual(0.9);
    }

    // Sales and an old restock lower it, without leaving the floor.
    const quiet = computeConfidence(counted(30, 20), [event("restock", 20, 5)], NOW);
    const selling = computeConfidence(counted(30, 20), [event("restock", 20, 5), event("sale", -60, 2)], NOW);
    expect(selling).toBeLessThan(quiet);
    const recountedOnly = computeConfidence(counted(90, 20), [event("restock", 20, 80), event("recount", 0, 3)], NOW);
    const recentlyRestocked = computeConfidence(counted(90, 20), [event("restock", 20, 3)], NOW);
    expect(recountedOnly).toBeLessThan(recentlyRestocked);
    expect(computeConfidence(counted(90, 1), [event("sale", -500, 1)], NOW)).toBeGreaterThanOrEqual(0.3);

    // Shortage evidence goes below the floor. A smaller rate or a newer confirmation does not.
    const shortages = [event("short", -3, 8), event("sale", -3, 9)];
    expect(computeConfidence(counted(90), shortages, NOW)).toBeLessThan(0.3);
    expect(computeConfidence(counted(90), [event("short", -1, 8), event("sale", -99, 9)], NOW)).toBeGreaterThanOrEqual(0.3);
    expect(computeConfidence(counted(90), [...shortages, event("recount", 0, 7)], NOW)).toBeGreaterThanOrEqual(0.3);
    // A short older than the window is no evidence.
    expect(computeConfidence(counted(90), [event("short", -3, 45)], NOW)).toBeGreaterThanOrEqual(0.3);

    // Finite and in range for awkward inputs, including an event dated after now.
    const awkward = [
      computeConfidence(counted(9, 0), [event("sale", -5, 1)], NOW),
      computeConfidence(counted(9, null), [event("sale", -5, 1)], NOW),
      computeConfidence({ createdAt: daysAgo(9), stockMode: "status", qty: null }, [event("short", -2, 1)], NOW),
      computeConfidence(counted(-2), [event("recount", 1, -2)], NOW),
    ];
    for (const value of awkward) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
