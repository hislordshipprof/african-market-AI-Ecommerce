import { describe, expect, it } from "vitest";
import { activeSection } from "./active-section";

const sections = (tops: number[]) =>
  ["fulfillment", "contact", "payment", "review"].map((id, i) => ({ id, top: tops[i] }));

describe("activeSection", () => {
  it("starts on the first section before anything has scrolled past the line", () => {
    expect(activeSection(sections([400, 900, 1400, 1900]), 180)).toBe("fulfillment");
  });

  it("marks the last section whose top has reached the line", () => {
    expect(activeSection(sections([-500, 120, 700, 1200]), 180)).toBe("contact");
    expect(activeSection(sections([-1500, -900, -200, 170]), 180)).toBe("review");
  });

  it("marks the last section once the page cannot scroll further", () => {
    expect(activeSection(sections([-1500, -900, 200, 500]), 180, true)).toBe("review");
  });

  it("returns null with no sections on the page", () => {
    expect(activeSection([], 180)).toBeNull();
  });
});
