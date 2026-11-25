import { describe, expect, it } from "vitest";
import { completionParts, latestOnly, moveActive, resultsMessage } from "./search-combobox";

describe("search box suggestions (#835)", () => {
  it("keeps the typed part normal and bolds the completion", () => {
    expect(completionParts("palm oil", "Pal")).toEqual([
      { text: "pal", bold: false },
      { text: "m oil", bold: true },
    ]);
  });

  it("bolds around a match at a later word, and everything when the store name does not hold the typed text", () => {
    expect(completionParts("dried fish (eja kika)", "eja")).toEqual([
      { text: "dried fish (", bold: true },
      { text: "eja", bold: false },
      { text: " kika)", bold: true },
    ]);
    expect(completionParts("scotch bonnet pepper", "ata")).toEqual([{ text: "scotch bonnet pepper", bold: true }]);
  });

  it("arrow keys walk every row and wrap; nothing highlighted means the typed text", () => {
    expect(moveActive(-1, 4, "ArrowDown")).toBe(0);
    expect(moveActive(3, 4, "ArrowDown")).toBe(0);
    expect(moveActive(-1, 4, "ArrowUp")).toBe(3);
    expect(moveActive(0, 4, "ArrowUp")).toBe(3);
    expect(moveActive(-1, 0, "ArrowDown")).toBe(-1);
  });

  it("an older keystroke's answer never replaces a newer one", () => {
    const latest = latestOnly();
    const pal = latest.next();
    const palm = latest.next();
    expect(latest.isCurrent(palm)).toBe(true);
    expect(latest.isCurrent(pal)).toBe(false);
  });

  it("tells screen readers how many rows each group holds", () => {
    expect(resultsMessage({ suggestions: 2, aisles: 1, products: 1 })).toBe("2 suggestions, 1 aisle, 1 product");
    expect(resultsMessage({ suggestions: 1, aisles: 0, products: 3 })).toBe("1 suggestion, 3 products");
    expect(resultsMessage({ suggestions: 0, aisles: 0, products: 0 })).toBe("");
  });
});
