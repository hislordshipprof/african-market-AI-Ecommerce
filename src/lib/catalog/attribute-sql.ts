import { Prisma } from "@prisma/client";
import type { Allergen, AttributeStatus, DietaryClaim, ProductAttributes, ShopperNeed } from "./attributes";

/**
 * The listing's attributes in SQL, the same rule as listingAttributes: each group from the master product,
 * else unknown, with the owner's correction where there is one; the safer value wins. Needs `l` (listings)
 * and `mp` (master_products, LEFT JOIN). Adds `attrs` with the columns AttributeRow reads.
 */
export const effectiveAttributesSql = Prisma.sql`
    LEFT JOIN listing_attributes la ON la.listing_id = l.id
    CROSS JOIN LATERAL (
      SELECT
        COALESCE(mp.ingredients_status, 'unknown') AS m_ing_status,
        COALESCE(mp.allergens_status, 'unknown') AS m_alg_status,
        COALESCE(mp.dietary_status, 'unknown') AS m_diet_status,
        ARRAY(SELECT mpi.ingredient_id FROM master_product_ingredients mpi WHERE mpi.product_id = mp.id) AS m_ing,
        ARRAY(SELECT li.ingredient_id FROM listing_ingredients li WHERE li.listing_id = l.id) AS o_ing
    ) attr_raw
    CROSS JOIN LATERAL (
      SELECT
        CASE WHEN la.ingredients_status IS NULL THEN attr_raw.m_ing_status
             WHEN la.ingredients_status = 'unknown' OR attr_raw.m_ing_status = 'unknown' THEN la.ingredients_status
             ELSE 'known' END AS ing_status,
        CASE WHEN la.ingredients_status IS NULL THEN attr_raw.m_ing
             WHEN la.ingredients_status = 'unknown' OR attr_raw.m_ing_status = 'unknown' THEN attr_raw.o_ing
             ELSE ARRAY(SELECT DISTINCT unnest(attr_raw.o_ing || attr_raw.m_ing)) END AS ing_ids,
        CASE WHEN la.allergens_status IS NULL THEN attr_raw.m_alg_status
             WHEN la.allergens_status = 'unknown' OR attr_raw.m_alg_status = 'unknown' THEN la.allergens_status
             ELSE 'known' END AS alg_status,
        CASE WHEN la.allergens_status IS NULL THEN COALESCE(mp.allergens, '{}')
             WHEN la.allergens_status = 'unknown' OR attr_raw.m_alg_status = 'unknown' THEN la.allergens
             ELSE ARRAY(SELECT DISTINCT unnest(la.allergens || mp.allergens)) END AS alg_values,
        CASE WHEN la.dietary_status IS NULL THEN attr_raw.m_diet_status
             WHEN la.dietary_status = 'unknown' OR attr_raw.m_diet_status = 'unknown' THEN la.dietary_status
             ELSE 'known' END AS diet_status,
        CASE WHEN la.dietary_status IS NULL THEN COALESCE(mp.dietary_claims, '{}')
             WHEN la.dietary_status = 'unknown' OR attr_raw.m_diet_status = 'unknown' THEN la.dietary_claims
             ELSE ARRAY(SELECT unnest(la.dietary_claims) INTERSECT SELECT unnest(mp.dietary_claims)) END AS diet_values
    ) attrs
`;

/** True when the need excludes the listing; the same rule as checkNeed returning "excluded". */
export function needExcludesSql(need: ShopperNeed): Prisma.Sql {
  const allergens = need.avoidAllergens ?? [];
  const ingredients = need.avoidIngredientIds ?? [];
  const claims = need.requireClaims ?? [];
  const parts: Prisma.Sql[] = [];
  if (allergens.length > 0) {
    parts.push(Prisma.sql`(attrs.alg_status <> 'unknown' AND attrs.alg_values && ${allergens}::text[])`);
  }
  if (ingredients.length > 0) {
    parts.push(Prisma.sql`(attrs.ing_status <> 'unknown' AND cardinality(attrs.ing_ids) > 0 AND attrs.ing_ids && ${ingredients}::text[])`);
  }
  if (claims.length > 0) {
    parts.push(Prisma.sql`(attrs.diet_status <> 'unknown' AND NOT (attrs.diet_values @> ${claims}::text[]))`);
  }
  return parts.length > 0 ? Prisma.join(parts, " OR ", "(", ")") : Prisma.sql`false`;
}

export interface AttributeRow {
  ing_status: string;
  ing_ids: string[];
  alg_status: string;
  alg_values: string[];
  diet_status: string;
  diet_values: string[];
}

export function attributesFromRow(row: AttributeRow): ProductAttributes {
  return {
    ingredients: { status: row.ing_status as AttributeStatus, ingredientIds: row.ing_ids },
    allergens: { status: row.alg_status as AttributeStatus, values: row.alg_values as Allergen[] },
    dietary: { status: row.diet_status as AttributeStatus, values: row.diet_values as DietaryClaim[] },
  };
}
