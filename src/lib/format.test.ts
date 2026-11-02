import { describe, expect, it } from "vitest";
import { formatWeight } from "./format";

describe("formatWeight", () => {
  it("formats 0 g", () => expect(formatWeight(0)).toBe("0 g"));
  it("keeps sub-kg weights in grams", () => expect(formatWeight(500)).toBe("500 g"));
  it("drops the decimal at exactly 1 kg", () => expect(formatWeight(1000)).toBe("1 kg"));
  it("shows fractional kg", () => expect(formatWeight(1500)).toBe("1.5 kg"));
});
