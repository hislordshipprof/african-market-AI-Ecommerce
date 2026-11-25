import { describe, expect, it } from "vitest";
import { descriptionProblems } from "./description-check";

describe("descriptionProblems: a description the assistant writes states only the product data (#833)", () => {
  it("passes a plain factual description", () => {
    expect(descriptionProblems("Ground melon seeds for egusi soup. 1 lb bag.", { originCountries: null })).toEqual([]);
  });

  it("refuses health claims", () => {
    for (const text of ["Boosts your immune system.", "Helps lower blood pressure.", "A natural remedy for colds.", "Cures fatigue."]) {
      expect(descriptionProblems(text, { originCountries: null }), text).toContain("a health claim");
    }
  });

  it("refuses prices", () => {
    for (const text of ["Only $4.99 a bag.", "Great price for 5 lb.", "Now 20% off."]) {
      expect(descriptionProblems(text, { originCountries: null }), text).toContain("a price");
    }
  });

  it("refuses an origin the product data does not give, and allows the one it does", () => {
    expect(descriptionProblems("Grown in Ghana.", { originCountries: null })).toContain("an origin the product data does not give (Ghana)");
    expect(descriptionProblems("Grown in Ghana.", { originCountries: "Ghana, Togo" })).toEqual([]);
    expect(descriptionProblems("Imported from Nigeria.", { originCountries: "Ghana" })).toContain("an origin the product data does not give (Nigeria)");
  });
});
