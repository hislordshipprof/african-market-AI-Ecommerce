import type { PrismaClient } from "@prisma/client";
import { lockSeededRecipe, readRecipeAdminChanges, withoutAdminChanges } from "../../../prisma/master-catalog-upsert";

// No app database client here: prisma/seed.ts imports this file.

/**
 * Folded dish name in any script: case-folded, Latin accents dropped, punctuation to single spaces.
 * Marks are stripped only after Latin letters; in scripts such as Devanagari a mark is part of the letter.
 */
export function dishKey(text: string): string {
  const key = text
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\p{M} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(key) ? key : "";
}

/** Keys a dish name is looked up by, in order: the whole name, then the part before its first " with " (#607). */
export function dishKeys(dish: string): string[] {
  const key = dishKey(dish);
  if (!key) return [];
  const head = key.split(" with ")[0] ?? "";
  return head && head !== key ? [key, head] : [key];
}

/** The declaration that answers a dish name, by the keys and order the database lookup uses. */
export function declaredRecipe(recipes: SeedRecipe[], dish: string): SeedRecipe | null {
  for (const key of dishKeys(dish)) {
    const match = recipes.find((recipe) => dishKey(recipe.name) === key)
      ?? recipes.find((recipe) => (recipe.aliases ?? []).some((alias) => dishKey(alias) === key));
    if (match) return match;
  }
  return null;
}

export interface SeedRecipe {
  name: string;
  aliases?: string[];
  cuisine?: string;
  servings: number;
  ingredients: Array<{ name: string; masterProductId?: string; qty: number; unit: string }>;
}

/** Seeds the curated base. Fails when a row names a master product that does not exist. */
export async function seedRecipeBase(prisma: PrismaClient, recipes: SeedRecipe[], log: (line: string) => void = console.log): Promise<number> {
  const ids = [...new Set(recipes.flatMap((recipe) => recipe.ingredients.flatMap((row) => row.masterProductId ?? [])))];
  const found = await prisma.masterProduct.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const known = new Set(found.map((row) => row.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) throw new Error(`Recipe base names unknown master products: ${missing.join(", ")}`);
  let kept = 0;
  for (const recipe of recipes) {
    const key = dishKey(recipe.name);
    const data = {
      name: recipe.name,
      aliases: (recipe.aliases ?? []).map(dishKey).filter((alias) => alias && alias !== key),
      cuisine: recipe.cuisine ?? null,
      servings: recipe.servings,
      sourceUrl: null,
      origin: "curated",
    };
    const ingredients = recipe.ingredients.map((ingredient, position) => ({
      position,
      name: ingredient.name,
      masterProductId: ingredient.masterProductId ?? null,
      qty: ingredient.qty,
      unit: ingredient.unit,
    }));
    // A re-seed keeps the fields a platform admin edited on a curated dish, also after a rename moved its key (#675).
    const keptAdminChanges = await prisma.$transaction(async (tx) => {
      // The recipe tables force RLS on their owner too (#713): the seed writes them as the platform admin.
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      const existing = await lockSeededRecipe(tx, key);
      if (!existing) {
        await tx.recipe.create({ data: { key, ...data, ingredients: { createMany: { data: ingredients } } } });
        return false;
      }
      const changes = await readRecipeAdminChanges(tx, existing.id);
      await tx.recipe.update({ where: { id: existing.id }, data: withoutAdminChanges(data, changes) });
      if (!changes.fields.has("ingredients")) {
        await tx.recipeIngredient.deleteMany({ where: { recipeId: existing.id } });
        await tx.recipeIngredient.createMany({ data: ingredients.map((row) => ({ recipeId: existing.id, ...row })) });
      }
      return changes.fields.size > 0;
    });
    if (keptAdminChanges) kept++;
  }
  log(`Kept admin changes on ${kept} ${kept === 1 ? "recipe" : "recipes"} (the fields an admin edited)`);
  return recipes.length;
}
