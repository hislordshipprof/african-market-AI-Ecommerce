import { describe, expect, it } from "vitest";
import { storeDayEnd } from "./driver-route";

describe("storeDayEnd", () => {
  it("is local midnight on DST change days, so a link never outlives the store day", () => {
    // 2026-03-08 springs forward in Chicago (23-hour day); 2026-11-01 falls back (25-hour day).
    expect(storeDayEnd("America/Chicago", new Date("2026-03-08T06:30:00Z"))).toEqual(new Date("2026-03-09T05:00:00Z"));
    expect(storeDayEnd("America/Chicago", new Date("2026-11-01T05:30:00Z"))).toEqual(new Date("2026-11-02T06:00:00Z"));
    expect(storeDayEnd("America/Chicago", new Date("2026-11-02T05:59:00Z"))).toEqual(new Date("2026-11-02T06:00:00Z"));
  });
});
