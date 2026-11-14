import { describe, expect, it } from "vitest";
import { canAutoplay } from "./motion";

describe("hero autoplay gate", () => {
  const ready = { reduced: false, paused: false, hovered: false, focused: false, visible: true, tabVisible: true, slides: 3 };
  it("runs only when all accessibility and visibility gates permit it", () => {
    expect(canAutoplay(ready)).toBe(true);
    for (const key of ["reduced", "paused", "hovered", "focused"] as const)
      expect(canAutoplay({ ...ready, [key]: true })).toBe(false);
    for (const key of ["visible", "tabVisible"] as const)
      expect(canAutoplay({ ...ready, [key]: false })).toBe(false);
    expect(canAutoplay({ ...ready, slides: 1 })).toBe(false);
    expect(canAutoplay({ ...ready, reduced: null })).toBe(false);
  });
  it("leaving hover cannot override an explicit pause or hidden tab", () => {
    expect(canAutoplay({ ...ready, hovered: false, paused: true })).toBe(false);
    expect(canAutoplay({ ...ready, focused: false, tabVisible: false })).toBe(false);
  });
});
