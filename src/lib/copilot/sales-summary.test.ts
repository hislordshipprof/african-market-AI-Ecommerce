import { describe, expect, it } from "vitest";
import { salesPeriod } from "./sales-summary";

// Tuesday 2026-11-24, 01:30 in New York (06:30 UTC); still Monday the 23rd in Los Angeles.
const NOW = new Date("2026-11-24T06:30:00Z");
const NY = "America/New_York";

describe("salesPeriod (#818)", () => {
  it("names today, this week, last week and this month in the store's time zone, weeks from Monday", () => {
    expect(salesPeriod({ period: "today" }, NY, NOW)).toEqual({ ok: true, from: "2026-11-24", to: "2026-11-24" });
    expect(salesPeriod({ period: "today" }, "America/Los_Angeles", NOW)).toEqual({ ok: true, from: "2026-11-23", to: "2026-11-23" });
    expect(salesPeriod({ period: "this_week" }, NY, NOW)).toEqual({ ok: true, from: "2026-11-23", to: "2026-11-24" });
    expect(salesPeriod({ period: "last_week" }, NY, NOW)).toEqual({ ok: true, from: "2026-11-16", to: "2026-11-22" });
    expect(salesPeriod({ period: "this_month" }, NY, NOW)).toEqual({ ok: true, from: "2026-11-01", to: "2026-11-24" });
  });

  it("takes a date range, ending it at today", () => {
    expect(salesPeriod({ period: "range", from: "2026-10-01", to: "2026-10-31" }, NY, NOW)).toEqual({ ok: true, from: "2026-10-01", to: "2026-10-31" });
    expect(salesPeriod({ period: "range", from: "2026-11-20", to: "2026-12-31" }, NY, NOW)).toEqual({ ok: true, from: "2026-11-20", to: "2026-11-24" });
  });

  it("refuses a range that is missing, not a real date, backwards, in the future or longer than a year, instead of guessing", () => {
    for (const bad of [
      { period: "range" as const },
      { period: "range" as const, from: "2026-02-30", to: "2026-03-02" },
      { period: "range" as const, from: "2026-11-10", to: "2026-11-01" },
      { period: "range" as const, from: "2026-12-01", to: "2026-12-05" },
      { period: "range" as const, from: "2024-01-01", to: "2026-11-01" },
    ]) {
      expect(salesPeriod(bad, NY, NOW)).toMatchObject({ ok: false });
    }
  });
});
