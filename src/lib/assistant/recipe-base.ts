import type { PrismaClient } from "@prisma/client";

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

export interface SeedRecipe {
  name: string;
  aliases?: string[];
  cuisine?: string;
  servings: number;
  ingredients: Array<{ name: string; masterProductId?: string; qty: number; unit: string }>;
}

/** Seeds the curated base. Fails when a row names a master product that does not exist. */
export async function seedRecipeBase(prisma: PrismaClient, recipes: SeedRecipe[]): Promise<number> {
  const ids = [...new Set(recipes.flatMap((recipe) => recipe.ingredients.flatMap((row) => row.masterProductId ?? [])))];
  const found = await prisma.masterProduct.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const known = new Set(found.map((row) => row.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) throw new Error(`Recipe base names unknown master products: ${missing.join(", ")}`);
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
    await prisma.$transaction(async (tx) => {
      const row = await tx.recipe.upsert({ where: { key }, create: { key, ...data }, update: data });
      await tx.recipeIngredient.deleteMany({ where: { recipeId: row.id } });
      await tx.recipeIngredient.createMany({
        data: recipe.ingredients.map((ingredient, position) => ({
          recipeId: row.id,
          position,
          name: ingredient.name,
          masterProductId: ingredient.masterProductId ?? null,
          qty: ingredient.qty,
          unit: ingredient.unit,
        })),
      });
    });
  }
  return recipes.length;
}
