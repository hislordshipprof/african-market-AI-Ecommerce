import { describe, expect, it } from "vitest";
import { checkNeed, type ProductAttributes } from "./attributes";

const unknownAll: ProductAttributes = {
  ingredients: { status: "unknown", ingredientIds: [] },
  allergens: { status: "unknown", values: [] },
  dietary: { status: "unknown", values: [] },
};

describe("checkNeed", () => {
  it("an unknown attribute is never safe: it cannot be confirmed, not ok and not excluded", () => {
    expect(checkNeed(unknownAll, { avoidAllergens: ["peanuts"] })).toBe("cannot_confirm");
    expect(checkNeed(unknownAll, { avoidIngredientIds: ["onion"] })).toBe("cannot_confirm");
    expect(checkNeed(unknownAll, { requireClaims: ["halal"] })).toBe("cannot_confirm");
  });

  it("known data decides: a listed allergen or ingredient excludes, a missing claim excludes, otherwise ok", () => {
    const known: ProductAttributes = {
      ingredients: { status: "reviewed", ingredientIds: ["onion", "pepper"] },
      allergens: { status: "known", values: ["peanuts"] },
      dietary: { status: "reviewed", values: ["vegan"] },
    };
    expect(checkNeed(known, { avoidAllergens: ["peanuts"] })).toBe("excluded");
    expect(checkNeed(known, { avoidAllergens: ["milk"] })).toBe("ok");
    expect(checkNeed(known, { avoidIngredientIds: ["onion"] })).toBe("excluded");
    expect(checkNeed(known, { avoidIngredientIds: ["garlic"] })).toBe("ok");
    expect(checkNeed(known, { requireClaims: ["halal"] })).toBe("excluded");
    expect(checkNeed(known, { requireClaims: ["vegan"] })).toBe("ok");
  });

  it("a known exclusion wins over another group that is unknown", () => {
    const mixed: ProductAttributes = { ...unknownAll, allergens: { status: "known", values: ["milk"] } };
    expect(checkNeed(mixed, { avoidAllergens: ["milk"], requireClaims: ["halal"] })).toBe("excluded");
    expect(checkNeed(mixed, { avoidAllergens: ["eggs"], requireClaims: ["halal"] })).toBe("cannot_confirm");
  });
});
