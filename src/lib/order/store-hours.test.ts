import { describe, it, expect } from "vitest";
import { isStoreOpen } from "./store-hours";

describe("isStoreOpen", () => {
  it("returns true during open hours (24h format, abbreviated day)", () => {
    const hours = { mon: { open: "09:00", close: "21:00" } };
    // Monday at 12:00
    const now = new Date("2026-11-02T12:00:00"); // Monday
    // 2026-11-02 is actually a Monday
    expect(isStoreOpen(hours, now)).toBe(true);
  });

  it("returns false outside hours (24h format, abbreviated day)", () => {
    const hours = { mon: { open: "09:00", close: "21:00" } };
    // Monday at 22:00
    const now = new Date("2026-11-02T22:00:00");
    expect(isStoreOpen(hours, now)).toBe(false);
  });

  it("handles string range format with AM/PM and full day names", () => {
    const hours = {
      monday: "9:00 AM - 8:00 PM",
      tuesday: "9:00 AM - 8:00 PM",
    };
    // Monday at 14:00
    const now = new Date("2026-11-02T14:00:00");
    expect(isStoreOpen(hours, now)).toBe(true);
  });

  it("returns false when store is closed on string range format", () => {
    const hours = {
      monday: "9:00 AM - 8:00 PM",
    };
    // Monday at 21:00 (9 PM)
    const now = new Date("2026-11-02T21:00:00");
    expect(isStoreOpen(hours, now)).toBe(false);
  });

  it("returns false for weekend when only weekday hours defined", () => {
    const hours = {
      mon: { open: "09:00", close: "21:00" },
      tue: { open: "09:00", close: "21:00" },
    };
    // Saturday
    const sat = new Date("2026-11-07T12:00:00");
    expect(isStoreOpen(hours, sat)).toBe(false);
  });

  it("handles weekend hours (saturday)", () => {
    const hours = {
      saturday: "8:00 AM - 9:00 PM",
    };
    // Saturday at 15:00
    const sat = new Date("2026-11-07T15:00:00");
    expect(isStoreOpen(hours, sat)).toBe(true);
  });

  it("returns false for null hours", () => {
    expect(isStoreOpen(null)).toBe(false);
  });

  it("returns false for undefined hours", () => {
    expect(isStoreOpen(undefined)).toBe(false);
  });

  it("returns false for empty object", () => {
    expect(isStoreOpen({})).toBe(false);
  });

  it("returns false at exactly closing time (boundary)", () => {
    const hours = { mon: { open: "09:00", close: "20:00" } };
    // Monday at exactly 20:00
    const now = new Date("2026-11-02T20:00:00");
    expect(isStoreOpen(hours, now)).toBe(false);
  });

  it("returns true at exactly opening time (boundary)", () => {
    const hours = { mon: { open: "09:00", close: "20:00" } };
    // Monday at exactly 09:00
    const now = new Date("2026-11-02T09:00:00");
    expect(isStoreOpen(hours, now)).toBe(true);
  });
});
