import type { LanguageModel } from "ai";
import { Prisma } from "@prisma/client";
import { storeScoped, storeScopedRawQuery } from "../../db";
import { searchCatalogHits } from "../../storefront/service";
import { dishKey } from "../recipe-base";
import { findRecipe, lookUpDishOnline, saveLookedUpRecipe, takeLookupSlot, type RecipeRow } from "../recipes";
import { stockBadge } from "../../storefront/stock-badge";
import { recordRead, type AssistantContext, type ToolResult } from "./execute";
import { getRecipeInput, parseToolInput } from "./schemas";

export interface RecipeDeps {
  /** Model for the web lookup: the chat's own model, so its calls are metered like the chat's. */
  lookupModel?: LanguageModel;
  now?: () => Date;
}

interface StoreItem {
  listingId: string;
  name: string;
  variantId: string;
  packLabel: string;
  priceCents: number;
  mayBeUnavailable: boolean;
}

interface Placed extends StoreItem {
  ingredient: string;
  /** Other recipe ingredients this same item fills. */
  covers?: string[];
  amount?: string;
  backupVariantId?: string;
}

/** Cheapest variant of this store's active listing for a master product. A listing without a variant cannot be added. */
async function listingForMaster(storeId: string, masterProductId: string): Promise<StoreItem | null> {
  const listing = await storeScoped(storeId).listing.findFirst({
    where: { masterProductId, active: true },
    include: { masterProduct: true, variants: { orderBy: [{ price: "asc" }, { id: "asc" }], take: 1 } },
    orderBy: [{ confidence: "desc" }, { id: "asc" }],
  });
  const variant = listing?.variants[0];
  if (!listing || !variant) return null;
  return {
    listingId: listing.id,
    name: listing.customName || listing.masterProduct?.name || "Unnamed",
    variantId: variant.id,
    packLabel: variant.label,
    priceCents: variant.price,
    mayBeUnavailable: stockBadge(listing) !== "in-stock",
  };
}

/** Name and synonym fits from the storefront search; a near row is not a fit. */
async function searchFits(storeId: string, name: string): Promise<StoreItem[]> {
  const hits = await searchCatalogHits(storeId, name);
  const fits = hits.filter((hit) => hit.match === "name" || hit.match === "synonym");
  const ranked = fits.some((hit) => hit.match === "name") ? fits.filter((hit) => hit.match === "name") : fits;
  return ranked.flatMap((hit) => hit.variantId ? [{
    listingId: hit.id,
    name: hit.name,
    variantId: hit.variantId,
    packLabel: hit.packLabel ?? "Each",
    priceCents: hit.price,
    mayBeUnavailable: hit.badge !== "in-stock",
  }] : []);
}

/**
 * The catalog search's exclude match: Postgres English text search on the name.
 * An ingredient is also ruled out when its whole name is inside an exclusion: "yellow onion" rules out onion.
 */
async function ruledOut(storeId: string, name: string, exclude: readonly string[], ingredient = false): Promise<boolean> {
  if (exclude.length === 0) return false;
  const rows = await storeScopedRawQuery<{ hit: boolean }>(
    storeId,
    Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM unnest(${[...exclude]}::text[]) AS word
      WHERE to_tsvector('english', unaccent(${name})) @@ plainto_tsquery('english', unaccent(word))
        OR (${ingredient} AND to_tsvector('english', unaccent(word)) @@ plainto_tsquery('english', unaccent(${name})))
    ) AS hit`,
  );
  return rows[0]?.hit === true;
}

async function allowed(storeId: string, items: StoreItem[], exclude: readonly string[]): Promise<StoreItem[]> {
  const kept: StoreItem[] = [];
  for (const item of items) if (!(await ruledOut(storeId, item.name, exclude))) kept.push(item);
  return kept;
}

function scaledAmount(qty: number | null, unit: string | null, base: number | null, servings: number): string | undefined {
  if (qty == null || !base) return undefined;
  const scaled = Math.round((qty * servings * 100) / base) / 100;
  return unit ? `${scaled} ${unit}` : String(scaled);
}

async function placeIngredients(storeId: string, recipe: RecipeRow, servings: number, exclude: readonly string[]) {
  const inStock: Placed[] = [];
  const lowOrOut: Placed[] = [];
  const notCarried: string[] = [];
  const excluded: string[] = [];
  const placedByListing = new Map<string, Placed>();
  for (const ingredient of recipe.ingredients) {
    if (await ruledOut(storeId, ingredient.name, exclude, true)) {
      excluded.push(ingredient.name);
      continue;
    }
    const fits = await allowed(storeId, await searchFits(storeId, ingredient.name), exclude);
    const master = ingredient.masterProductId ? await listingForMaster(storeId, ingredient.masterProductId) : null;
    const [mapped] = master ? await allowed(storeId, [master], exclude) : [];
    const pick = mapped ?? fits.find((item) => !item.mayBeUnavailable) ?? fits[0];
    if (!pick) {
      notCarried.push(ingredient.name);
      continue;
    }
    const already = placedByListing.get(pick.listingId);
    if (already) {
      already.covers = [...(already.covers ?? []), ingredient.name];
      continue;
    }
    const amount = scaledAmount(ingredient.qty, ingredient.unit, recipe.servings, servings);
    const placed: Placed = { ingredient: ingredient.name, ...(amount ? { amount } : {}), ...pick };
    placedByListing.set(pick.listingId, placed);
    if (!pick.mayBeUnavailable) {
      inStock.push(placed);
      continue;
    }
    const backup = fits.find((item) => item.listingId !== pick.listingId && !item.mayBeUnavailable);
    if (backup) placed.backupVariantId = backup.variantId;
    lowOrOut.push(placed);
  }
  return { inStock, lowOrOut, notCarried, ...(excluded.length > 0 ? { excluded } : {}) };
}

/** The chat saves only its own steps' cost, so the lookup adds its own to the conversation. */
async function addConversationCost(ctx: AssistantContext, micros: bigint): Promise<void> {
  if (micros === BigInt(0)) return;
  try {
    await storeScoped(ctx.storeId).aiConversation.update({
      where: { id: ctx.conversationId },
      data: { costMicros: { increment: micros } },
    });
  } catch (error) {
    console.error("[assistant] recipe lookup cost not saved", error);
  }
}

export async function getRecipe(ctx: AssistantContext, input: unknown, deps: RecipeDeps = {}): Promise<ToolResult> {
  const parsed = parseToolInput(getRecipeInput, input);
  if (parsed.servings == null) {
    return recordRead(ctx, "get_recipe", parsed, { ok: true, askServings: true, dish: parsed.dish });
  }
  const notFound = () => recordRead(ctx, "get_recipe", parsed, {
    ok: false,
    code: "recipe_not_found",
    message: "I couldn't find a recipe for that dish. Tell me the ingredients and I'll find them.",
  });
  if (!dishKey(parsed.dish)) return notFound();
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
    try {
      const lookup = await lookUpDishOnline(parsed.dish, { model: deps.lookupModel });
      await addConversationCost(ctx, lookup.costMicros);
      if (lookup.found) recipe = await saveLookedUpRecipe(parsed.dish, lookup.found);
    } catch (error) {
      console.error("[assistant] recipe lookup failed", error);
    }
    if (!recipe) return notFound();
    lookedUp = true;
  }
  const groups = await placeIngredients(ctx.storeId, recipe, parsed.servings, parsed.exclude ?? []);
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
