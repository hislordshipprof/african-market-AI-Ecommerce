import { describe, expect, it } from "vitest";
import { formatMiles } from "./distance";

describe("formatMiles", () => {
  it("shows tenths under 10 miles and whole miles beyond", () => {
    expect(formatMiles(0.04)).toBe("0.1 mi");
    expect(formatMiles(3.24)).toBe("3.2 mi");
    expect(formatMiles(9.96)).toBe("10 mi");
    expect(formatMiles(63.4)).toBe("63 mi");
    expect(formatMiles(1234.5)).toBe("1,235 mi");
  });
});
