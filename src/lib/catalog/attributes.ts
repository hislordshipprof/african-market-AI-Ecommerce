/** The US top 9 allergens (FALCPA plus sesame, FASTER Act 2021). */
export const ALLERGENS = [
  "milk",
  "eggs",
  "fish",
  "crustacean_shellfish",
  "tree_nuts",
  "peanuts",
  "wheat",
  "soybeans",
  "sesame",
] as const;
export type Allergen = (typeof ALLERGENS)[number];

export const DIETARY_CLAIMS = ["halal", "kosher", "vegan", "vegetarian", "no_pork", "gluten_free"] as const;
export type DietaryClaim = (typeof DIETARY_CLAIMS)[number];

/** unknown: no data. known: stated by a store owner. reviewed: approved by a platform admin. */
export type AttributeStatus = "unknown" | "known" | "reviewed";

export interface ProductAttributes {
  ingredients: { status: AttributeStatus; ingredientIds: string[] };
  /** Allergens the product contains. With a known status, an allergen not listed is absent. */
  allergens: { status: AttributeStatus; values: Allergen[] };
  /** Claims that hold. With a known status, a claim not listed does not hold. */
  dietary: { status: AttributeStatus; values: DietaryClaim[] };
}

export interface ShopperNeed {
  avoidAllergens?: Allergen[];
  avoidIngredientIds?: string[];
  requireClaims?: DietaryClaim[];
}

export type NeedResult = "ok" | "excluded" | "cannot_confirm";

/** Unknown is never safe: a need that touches an unknown group cannot be confirmed. */
export function checkNeed(attributes: ProductAttributes, need: ShopperNeed): NeedResult {
  let unknown = false;
  const avoidAllergens = need.avoidAllergens ?? [];
  const avoidIngredients = need.avoidIngredientIds ?? [];
  const requireClaims = need.requireClaims ?? [];

  if (avoidAllergens.length > 0) {
    if (attributes.allergens.status === "unknown") unknown = true;
    else if (avoidAllergens.some((a) => attributes.allergens.values.includes(a))) return "excluded";
  }
  if (avoidIngredients.length > 0) {
    if (attributes.ingredients.status === "unknown") unknown = true;
    else if (avoidIngredients.some((i) => attributes.ingredients.ingredientIds.includes(i))) return "excluded";
  }
  if (requireClaims.length > 0) {
    if (attributes.dietary.status === "unknown") unknown = true;
    else if (!requireClaims.every((c) => attributes.dietary.values.includes(c))) return "excluded";
  }
  return unknown ? "cannot_confirm" : "ok";
}
