import { describe, expect, it } from "vitest";
import { parsePaletteQuery } from "./palette-query";

describe("parsePaletteQuery", () => {
  it("splits store words from an order number", () => {
    expect(parsePaletteQuery("mama ngozi #1042")).toEqual({ text: "mama ngozi", number: 1042 });
    expect(parsePaletteQuery("1042 tante")).toEqual({ text: "tante", number: 1042 });
    expect(parsePaletteQuery("  Lagos  ")).toEqual({ text: "Lagos", number: null });
  });

  it("reads nothing from a query too short, too long or with a number out of range", () => {
    expect(parsePaletteQuery("a")).toEqual({ text: "", number: null });
    expect(parsePaletteQuery("x".repeat(101))).toEqual({ text: "", number: null });
    expect(parsePaletteQuery("shop 12345678901")).toEqual({ text: "shop", number: null });
  });
});
