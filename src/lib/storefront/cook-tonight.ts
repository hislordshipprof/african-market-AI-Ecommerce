import { listCuratedRecipes } from "../assistant/recipes";
import { fillRecipe } from "../assistant/tools/recipe";
import { cachedStorefrontRead } from "./cache";
import { getActiveListings, type StorefrontListing } from "./service";

const DISHES = 3;

export interface CookTonightItem {
  listingId: string;
  variantId: string;
  name: string;
  price: number;
  packLabel: string;
  imageUrl?: string;
  categorySlug?: string;
  maxPerOrder?: number;
  stockLeft?: number;
  cateringMinQty?: number;
}

export interface CookTonightDish {
  name: string;
  servings: number;
  ingredientCount: number;
  /** One in-stock pick per ingredient the store sells: what "Add all" puts in the basket. */
  items: CookTonightItem[];
  /** Ingredients the store has no in-stock pick for; the shopper brings these. */
  missing: string[];
  totalCents: number;
}

/**
 * Home's Cook tonight (#862 AC5): recipe-base dishes the store can mostly fill, through the assistant's own
 * recipe-to-store matching. A dish shows when the store has an in-stock pick for at least half its ingredients;
 * fuller dishes first.
 */
async function readCookTonight(storeId: string): Promise<CookTonightDish[]> {
  const [recipes, listings] = await Promise.all([listCuratedRecipes(), getActiveListings(storeId)]);
  const byId = new Map<string, StorefrontListing>(listings.map((listing) => [listing.id, listing]));
  const dishes: CookTonightDish[] = [];
  // One recipe at a time: each fill opens several store-scoped transactions, and in parallel they drain the pool.
  for (const recipe of recipes) {
    const servings = recipe.servings ?? 4;
    const filled = await fillRecipe(storeId, recipe, servings);
    const items = filled.inStock.map((placed): CookTonightItem => {
      const listing = byId.get(placed.listingId);
      return {
        listingId: placed.listingId,
        variantId: placed.variantId,
        name: placed.name,
        price: placed.priceCents,
        packLabel: placed.packLabel,
        imageUrl: listing?.imageUrl,
        categorySlug: listing?.categorySlug,
        maxPerOrder: listing?.maxPerOrder,
        stockLeft: listing?.stockLeft,
        cateringMinQty: listing?.cateringMinQty,
      };
    });
    const covered = new Set(filled.inStock.flatMap((placed) => [placed.ingredient, ...(placed.covers ?? [])]));
    const missing = recipe.ingredients.map((ingredient) => ingredient.name).filter((name) => !covered.has(name));
    dishes.push({
      name: recipe.name,
      servings,
      ingredientCount: recipe.ingredients.length,
      items,
      missing,
      totalCents: items.reduce((sum, item) => sum + item.price, 0),
    });
  }
  return dishes
    .filter((dish) => dish.items.length > 0 && dish.missing.length * 2 <= dish.ingredientCount)
    .sort((left, right) => left.missing.length / left.ingredientCount - right.missing.length / right.ingredientCount || left.name.localeCompare(right.name))
    .slice(0, DISHES);
}

export function cookTonight(storeId: string) {
  return cachedStorefrontRead(storeId, JSON.stringify(["cookTonight"]), () => readCookTonight(storeId));
}
