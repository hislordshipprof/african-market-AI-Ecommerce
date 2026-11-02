import { describe, it, expect } from "vitest";
import { isStoreOpen } from "./store-hours";

const NY = "America/New_York";
const CHICAGO = "America/Chicago";

describe("isStoreOpen", () => {
  it("returns true during open hours (24h format, abbreviated day)", () => {
    const hours = { mon: { open: "09:00", close: "21:00" } };
    // Monday 2026-11-02 at 12:00 ET
    const now = new Date("2026-11-02T17:00:00Z"); // 12:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(true);
  });

  it("returns false outside hours (24h format, abbreviated day)", () => {
    const hours = { mon: { open: "09:00", close: "21:00" } };
    // Monday at 22:00 ET
    const now = new Date("2026-11-03T03:00:00Z"); // 22:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(false);
  });

  it("handles string range format with AM/PM and full day names", () => {
    const hours = {
      monday: "9:00 AM - 8:00 PM",
      tuesday: "9:00 AM - 8:00 PM",
    };
    // Monday at 14:00 ET
    const now = new Date("2026-11-02T19:00:00Z"); // 14:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(true);
  });

  it("returns false when store is closed on string range format", () => {
    const hours = {
      monday: "9:00 AM - 8:00 PM",
    };
    // Monday at 21:00 ET (9 PM)
    const now = new Date("2026-11-03T02:00:00Z"); // 21:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(false);
  });

  it("returns false for weekend when only weekday hours defined", () => {
    const hours = {
      mon: { open: "09:00", close: "21:00" },
      tue: { open: "09:00", close: "21:00" },
    };
    // Saturday at 12:00 ET
    const sat = new Date("2026-11-07T17:00:00Z");
    expect(isStoreOpen(hours, NY, sat)).toBe(false);
  });

  it("handles weekend hours (saturday)", () => {
    const hours = {
      saturday: "8:00 AM - 9:00 PM",
    };
    // Saturday at 15:00 ET
    const sat = new Date("2026-11-07T20:00:00Z");
    expect(isStoreOpen(hours, NY, sat)).toBe(true);
  });

  it("returns false for null hours", () => {
    expect(isStoreOpen(null, NY)).toBe(false);
  });

  it("returns false for undefined hours", () => {
    expect(isStoreOpen(undefined, NY)).toBe(false);
  });

  it("returns false for empty object", () => {
    expect(isStoreOpen({}, NY)).toBe(false);
  });

  it("returns false at exactly closing time (boundary)", () => {
    const hours = { mon: { open: "09:00", close: "20:00" } };
    // Monday at exactly 20:00 ET
    const now = new Date("2026-11-03T01:00:00Z"); // 20:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(false);
  });

  it("returns true at exactly opening time (boundary)", () => {
    const hours = { mon: { open: "09:00", close: "20:00" } };
    // Monday at exactly 09:00 ET
    const now = new Date("2026-11-02T14:00:00Z"); // 09:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(true);
  });

  // Finding 6/7: timezone tests
  it("Houston (America/Chicago) at 2026-11-03T01:00Z is Monday 19:00 CT (open)", () => {
    const hours = { mon: { open: "08:00", close: "22:00" } };
    // 2026-11-03T01:00Z = Mon 19:00 CT (CDT ended Nov 1)
    const now = new Date("2026-11-03T01:00:00Z");
    expect(isStoreOpen(hours, CHICAGO, now)).toBe(true);
  });

  it("Houston store closed before open at same UTC", () => {
    const hours = { mon: { open: "20:00", close: "22:00" } };
    // 2026-11-03T01:00Z = Mon 19:00 CT — before 20:00 open
    const now = new Date("2026-11-03T01:00:00Z");
    expect(isStoreOpen(hours, CHICAGO, now)).toBe(false);
  });

  // Finding 6/7: overnight hours tests
  it("overnight window 20:00–02:00 at 23:00 (open)", () => {
    const hours = { mon: { open: "20:00", close: "02:00" } };
    // Monday 23:00 ET
    const now = new Date("2026-11-03T04:00:00Z"); // 23:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(true);
  });

  it("overnight window 20:00–02:00 at 01:00 next day (still open from yesterday)", () => {
    const hours = { mon: { open: "20:00", close: "02:00" } };
    // Tuesday 01:00 ET — still in Monday's overnight window
    const now = new Date("2026-11-03T06:00:00Z"); // Tue 01:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(true);
  });

  it("overnight window 20:00–02:00 at 03:00 next day (closed)", () => {
    const hours = { mon: { open: "20:00", close: "02:00" } };
    // Tuesday 03:00 ET — after Monday's overnight closes
    const now = new Date("2026-11-03T08:00:00Z"); // Tue 03:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(false);
  });

  it("overnight window 20:00–02:00 at 19:00 (before open, closed)", () => {
    const hours = { mon: { open: "20:00", close: "02:00" } };
    // Monday 19:00 ET
    const now = new Date("2026-11-03T00:00:00Z"); // Mon 19:00 ET
    expect(isStoreOpen(hours, NY, now)).toBe(false);
  });
});
