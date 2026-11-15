import { describe, expect, it } from "vitest";
import { zipState } from "./zip-state";

describe("zipState", () => {
  it("names the state from the ZIP prefix, across a border the nearest town would get wrong", () => {
    expect(zipState("10001")).toBe("NY");
    expect(zipState("07030")).toBe("NJ");
    expect(zipState("77002")).toBe("TX");
    expect(zipState("99723")).toBe("AK");
  });

  it("keeps the odd prefixes: Andover MA in Vermont's range, Austin TX in Oklahoma's, El Paso's 885, DC's 569", () => {
    expect(zipState("05501")).toBe("MA");
    expect(zipState("73301")).toBe("TX");
    expect(zipState("88510")).toBe("TX");
    expect(zipState("56901")).toBe("DC");
    expect(zipState("20101")).toBe("VA");
  });

  it("returns null for territories, military and anything not a 5-digit ZIP", () => {
    expect(zipState("00901")).toBeNull();
    expect(zipState("09001")).toBeNull();
    expect(zipState("96910")).toBeNull();
    expect(zipState("1000")).toBeNull();
  });
});
