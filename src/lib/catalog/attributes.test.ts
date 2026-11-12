import { describe, expect, it } from "vitest";
import { attributeGroup, checkNeed, type ProductAttributes } from "./attributes";

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

describe("attributeGroup: unknown is never safe, at every write", () => {
  it("ingredients that are empty after normalising are never known: unread from AI, refused from an owner", () => {
    expect(attributeGroup("ingredients", [" ", ""], "ai_read")).toEqual({ ok: true, group: null });
    expect(attributeGroup("ingredients", [], "ai_read")).toEqual({ ok: true, group: null });
    expect(attributeGroup("ingredients", [" ", ""], "admin_review")).toEqual({ ok: true, group: null });
    expect(attributeGroup("ingredients", [], "owner")).toEqual({
      ok: false,
      error: "List at least one ingredient, or mark the ingredients as unknown",
    });
    expect(attributeGroup("ingredients", [" Palm  Oil ", "palm oil", ""], "admin_review")).toEqual({
      ok: true,
      group: { status: "reviewed", values: ["palm oil"] },
    });
  });

  it("an empty allergen or claim list is 'none' only as a human claim; an AI read of [] stays a proposal", () => {
    expect(attributeGroup("allergens", [], "ai_read")).toEqual({ ok: true, group: { status: "proposed", values: [] } });
    expect(attributeGroup("allergens", [], "admin_review")).toEqual({ ok: true, group: { status: "reviewed", values: [] } });
    expect(attributeGroup("dietary", [], "owner")).toEqual({ ok: true, group: { status: "known", values: [] } });
  });

  it("an off-enum allergen or claim leaves the whole group unread", () => {
    expect(attributeGroup("allergens", ["peanuts", "mustard"], "ai_read")).toEqual({ ok: true, group: null });
    expect(attributeGroup("dietary", ["organic"], "admin_review")).toEqual({ ok: true, group: null });
    expect(attributeGroup("allergens", ["Peanuts"], "owner")).toMatchObject({ ok: false });
  });

  it("no value is unread from AI or a review, and a stated unknown from an owner", () => {
    expect(attributeGroup("allergens", null, "ai_read")).toEqual({ ok: true, group: null });
    expect(attributeGroup("ingredients", undefined, "admin_review")).toEqual({ ok: true, group: null });
    expect(attributeGroup("dietary", null, "owner")).toEqual({ ok: true, group: { status: "unknown", values: [] } });
  });

  it("an over-cap ingredient list is unread from AI, not cut short", () => {
    const seventy = Array.from({ length: 70 }, (_, i) => `ingredient ${i + 1}`);
    expect(attributeGroup("ingredients", seventy, "ai_read")).toEqual({ ok: true, group: null });
  });
});

describe("checkNeed on stored data that breaks the rule", () => {
  it("a known ingredient group with no ingredients cannot be confirmed", () => {
    const empty: ProductAttributes = { ...unknownAll, ingredients: { status: "reviewed", ingredientIds: [] } };
    expect(checkNeed(empty, { avoidIngredientIds: ["onion"] })).toBe("cannot_confirm");
  });
});
