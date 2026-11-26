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
  /** One in-stock pick per ingredient the store sells: what "Add all" puts in the basket. */
  items: CookTonightItem[];
  totalCents: number;
}

/**
 * Home's Cook tonight (#862 AC5): recipe-base dishes the store can fill, through the assistant's own
 * recipe-to-store matching. A dish shows only when the store has an in-stock pick for every ingredient.
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
    if (!recipe.ingredients.every((ingredient) => covered.has(ingredient.name))) continue;
    dishes.push({
      name: recipe.name,
      servings,
      items,
      totalCents: items.reduce((sum, item) => sum + item.price, 0),
    });
  }
  return dishes.sort((left, right) => left.name.localeCompare(right.name)).slice(0, DISHES);
}

export function cookTonight(storeId: string) {
  return cachedStorefrontRead(storeId, JSON.stringify(["cookTonight"]), () => readCookTonight(storeId));
}
