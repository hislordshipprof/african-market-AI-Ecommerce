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

export const INGREDIENTS_MAX = 60;
const NAME_MAX = 100;

/** One spelling per ingredient: trimmed, lower case, single spaces. */
export function normaliseIngredientName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ").slice(0, NAME_MAX);
}

/** Who states a group: a model reading the label, a platform admin approving that read, or the store owner. */
export type AttributeSource = "ai_read" | "admin_review" | "owner";

export interface AttributeGroupValues {
  ingredients: string;
  allergens: Allergen;
  dietary: DietaryClaim;
}
export type AttributeGroupName = keyof AttributeGroupValues;

/** An AI read is only ever "proposed": it waits for a platform admin. */
export type GroupStatus = AttributeStatus | "proposed";

export type AttributeGroupResult<K extends AttributeGroupName> =
  | { ok: true; group: { status: GroupStatus; values: AttributeGroupValues[K][] } | null }
  | { ok: false; error: string };

const SOURCE_STATUS: Record<AttributeSource, GroupStatus> = { ai_read: "proposed", admin_review: "reviewed", owner: "known" };
const ENUMS: Record<"allergens" | "dietary", readonly string[]> = { allergens: ALLERGENS, dietary: DIETARY_CLAIMS };

/**
 * The one place a raw group value becomes attribute data. Unknown is never safe:
 * a group that cannot be read is unread (null), never an empty list, and an owner is refused instead.
 * null or undefined is unread from a model or a review, and a stated unknown from an owner.
 */
export function attributeGroup<K extends AttributeGroupName>(
  name: K,
  raw: unknown,
  source: AttributeSource,
): AttributeGroupResult<K> {
  const unread = (error: string): AttributeGroupResult<K> => (source === "owner" ? { ok: false, error } : { ok: true, group: null });
  if (raw === null || raw === undefined) {
    return { ok: true, group: source === "owner" ? { status: "unknown", values: [] } : null };
  }
  if (!Array.isArray(raw) || !raw.every((value) => typeof value === "string")) return unread("Check the attributes and try again");
  let values: string[];
  if (name === "ingredients") {
    if (raw.length > INGREDIENTS_MAX) return unread(`List at most ${INGREDIENTS_MAX} ingredients`);
    values = [...new Set(raw.map(normaliseIngredientName).filter((value) => value !== ""))];
    // An empty ingredient list says nothing about what the product contains.
    if (values.length === 0) return unread("List at least one ingredient, or mark the ingredients as unknown");
  } else {
    const allowed = ENUMS[name as "allergens" | "dietary"];
    const off = raw.filter((value) => !allowed.includes(value));
    if (off.length > 0) return unread(`Not a listed value: ${off.join(", ")}`);
    values = [...new Set(raw)];
  }
  return { ok: true, group: { status: SOURCE_STATUS[source], values: values as AttributeGroupValues[K][] } };
}

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
    // A known group with no ingredients predates attributeGroup; it says nothing, so it is unknown too.
    if (attributes.ingredients.status === "unknown" || attributes.ingredients.ingredientIds.length === 0) unknown = true;
    else if (avoidIngredients.some((i) => attributes.ingredients.ingredientIds.includes(i))) return "excluded";
  }
  if (requireClaims.length > 0) {
    if (attributes.dietary.status === "unknown") unknown = true;
    else if (!requireClaims.every((c) => attributes.dietary.values.includes(c))) return "excluded";
  }
  return unknown ? "cannot_confirm" : "ok";
}
