import { describe, expect, it } from "vitest";
import { gazetteerPlaceName, parseNearQuery, placeKey } from "./near-query";

describe("placeKey", () => {
  it("matches Saint and St., accents and spacing the same way", () => {
    expect(placeKey("St. Louis")).toBe(placeKey("saint  louis"));
    expect(placeKey("San José")).toBe(placeKey("san jose"));
    expect(placeKey("Winston-Salem")).toBe(placeKey("winston salem"));
  });

  it("matches Ft. and Fort, Mt. and Mount the same way", () => {
    expect(placeKey("Ft Worth")).toBe(placeKey("Fort Worth"));
    expect(placeKey("Mt. Vernon")).toBe(placeKey("mount vernon"));
    expect(placeKey("Lake Mt. Pleasant")).toBe(placeKey("lake mount pleasant"));
  });
});

describe("gazetteerPlaceName", () => {
  it("drops the Census type suffix", () => {
    expect(gazetteerPlaceName("Houston city", "25")).toBe("Houston");
    expect(gazetteerPlaceName("Juneau city and borough", "53")).toBe("Juneau");
    expect(gazetteerPlaceName("Abanda CDP", "57")).toBe("Abanda");
    expect(gazetteerPlaceName("Carson City", "00")).toBe("Carson City");
  });

  it("keeps the city part of a consolidated government", () => {
    expect(gazetteerPlaceName("Nashville-Davidson metropolitan government (balance)", "00")).toBe("Nashville");
    expect(gazetteerPlaceName("Louisville/Jefferson County metro government (balance)", "00")).toBe("Louisville");
    expect(gazetteerPlaceName("Indianapolis city (balance)", "00")).toBe("Indianapolis");
  });
});

describe("parseNearQuery", () => {
  it("reads a ZIP or ZIP+4", () => {
    expect(parseNearQuery(" 77002 ")).toEqual({ kind: "zip", zip: "77002" });
    expect(parseNearQuery("77002-1234")).toEqual({ kind: "zip", zip: "77002" });
  });

  it("reads a city with or without a state", () => {
    expect(parseNearQuery("Houston, TX")).toEqual({ kind: "city", key: "houston", state: "TX" });
    expect(parseNearQuery("houston tx")).toEqual({ kind: "city", key: "houston", state: "TX" });
    expect(parseNearQuery("St. Paul, Minnesota")).toEqual({ kind: "city", key: placeKey("St Paul"), state: "MN" });
    expect(parseNearQuery("Houston")).toEqual({ kind: "city", key: "houston", state: null });
  });

  it("refuses empty, partial ZIP and overlong input", () => {
    expect(parseNearQuery("   ")).toBeNull();
    expect(parseNearQuery("7700")).toBeNull();
    expect(parseNearQuery("a".repeat(81))).toBeNull();
  });
});
