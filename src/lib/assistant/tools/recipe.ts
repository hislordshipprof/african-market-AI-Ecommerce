import type { LanguageModel } from "ai";
import { storeScoped } from "../../db";
import { searchCatalogHits } from "../../storefront/service";
import { findRecipe, lookUpDishOnline, saveLookedUpRecipe, takeLookupSlot, type RecipeRow } from "../recipes";
import { mayBeUnavailable } from "./availability";
import { recordRead, type AssistantContext, type ToolResult } from "./execute";
import { getRecipeInput, parseToolInput } from "./schemas";

export interface RecipeDeps {
  /** Model for the web lookup. Production builds one per lookup. */
  lookupModel?: LanguageModel;
  now?: () => Date;
}

interface StoreItem {
  listingId: string;
  name: string;
  variantId: string | null;
  packLabel: string;
  priceCents: number;
  mayBeUnavailable: boolean;
}

interface Placed extends StoreItem {
  ingredient: string;
  amount?: string;
  backupVariantId?: string;
}

/** Cheapest variant of this store's active listing for a master product. */
async function listingForMaster(storeId: string, masterProductId: string): Promise<StoreItem | null> {
  const listing = await storeScoped(storeId).listing.findFirst({
    where: { masterProductId, active: true },
    include: { masterProduct: true, variants: { orderBy: [{ price: "asc" }, { id: "asc" }], take: 1 } },
    orderBy: [{ confidence: "desc" }, { id: "asc" }],
  });
  if (!listing) return null;
  const variant = listing.variants[0];
  return {
    listingId: listing.id,
    name: listing.customName || listing.masterProduct?.name || "Unnamed",
    variantId: variant?.id ?? null,
    packLabel: variant?.label ?? "Each",
    priceCents: variant?.price ?? listing.price,
    mayBeUnavailable: mayBeUnavailable(listing),
  };
}

/** Name and synonym fits from the storefront search; a near row is not a fit. */
async function searchFits(storeId: string, name: string): Promise<StoreItem[]> {
  const hits = await searchCatalogHits(storeId, name);
  const fits = hits.filter((hit) => hit.match === "name" || hit.match === "synonym");
  const ranked = fits.some((hit) => hit.match === "name") ? fits.filter((hit) => hit.match === "name") : fits;
  return ranked.map((hit) => ({
    listingId: hit.id,
    name: hit.name,
    variantId: hit.variantId ?? null,
    packLabel: hit.packLabel ?? "Each",
    priceCents: hit.price,
    mayBeUnavailable: hit.badge !== "in-stock",
  }));
}

function scaledAmount(qty: number | null, unit: string | null, base: number | null, servings: number): string | undefined {
  if (qty == null || !base) return undefined;
  const scaled = Math.round((qty * servings * 100) / base) / 100;
  return unit ? `${scaled} ${unit}` : String(scaled);
}

async function placeIngredients(storeId: string, recipe: RecipeRow, servings: number) {
  const inStock: Placed[] = [];
  const lowOrOut: Placed[] = [];
  const notCarried: string[] = [];
  const used = new Set<string>();
  for (const ingredient of recipe.ingredients) {
    const fits = await searchFits(storeId, ingredient.name);
    const mapped = ingredient.masterProductId ? await listingForMaster(storeId, ingredient.masterProductId) : null;
    const pick = mapped ?? fits.find((item) => !item.mayBeUnavailable) ?? fits[0];
    if (!pick || used.has(pick.listingId)) {
      if (!pick) notCarried.push(ingredient.name);
      continue;
    }
    used.add(pick.listingId);
    const amount = scaledAmount(ingredient.qty, ingredient.unit, recipe.servings, servings);
    const placed: Placed = { ingredient: ingredient.name, ...(amount ? { amount } : {}), ...pick };
    if (!pick.mayBeUnavailable) {
      inStock.push(placed);
      continue;
    }
    const backup = fits.find((item) => item.listingId !== pick.listingId && !item.mayBeUnavailable && item.variantId);
    lowOrOut.push(backup?.variantId ? { ...placed, backupVariantId: backup.variantId } : placed);
  }
  return { inStock, lowOrOut, notCarried };
}

export async function getRecipe(ctx: AssistantContext, input: unknown, deps: RecipeDeps = {}): Promise<ToolResult> {
  const parsed = parseToolInput(getRecipeInput, input);
  if (parsed.servings == null) {
    return recordRead(ctx, "get_recipe", parsed, { ok: true, askServings: true, dish: parsed.dish });
  }
  let recipe = await findRecipe(parsed.dish);
  let lookedUp = false;
  if (!recipe) {
    const now = (deps.now ?? (() => new Date()))();
    if (!(await takeLookupSlot(ctx.storeId, now))) {
      return recordRead(ctx, "get_recipe", parsed, {
        ok: false,
        code: "lookup_limit",
        message: "I can't look up new recipes for this store today. Tell me the ingredients and I'll find them.",
      });
    }
    let found = null;
    try {
      found = await lookUpDishOnline(parsed.dish, { model: deps.lookupModel });
    } catch (error) {
      console.error("[assistant] recipe lookup failed", error);
    }
    if (!found) {
      return recordRead(ctx, "get_recipe", parsed, {
        ok: false,
        code: "recipe_not_found",
        message: "I couldn't find a recipe for that dish. Tell me the ingredients and I'll find them.",
      });
    }
    recipe = await saveLookedUpRecipe(parsed.dish, found);
    lookedUp = true;
  }
  const groups = await placeIngredients(ctx.storeId, recipe, parsed.servings);
  return recordRead(ctx, "get_recipe", parsed, {
    ok: true,
    askServings: false,
    recipe: recipe.name,
    servings: parsed.servings,
    basedOn: "common recipes",
    source: recipe.sourceUrl ?? "the store's recipe base",
    lookedUp,
    ...groups,
  });
}
