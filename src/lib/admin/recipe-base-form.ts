import { z } from "zod";
import { dishKey } from "../assistant/recipe-base";

/** "curated" for the seeded base and dishes an admin marked curated, "lookup" for a dish saved from an online lookup. */
export const RECIPE_ORIGINS = ["curated", "lookup"] as const;
export type RecipeOrigin = (typeof RECIPE_ORIGINS)[number];

export const RECIPE_ORIGIN_LABELS: Record<RecipeOrigin, string> = { curated: "Curated", lookup: "Looked up" };

export const RECIPE_PAGE_SIZE = 25;
export const MAX_RECIPE_INGREDIENTS = 50;

/** Save, mark curated and delete refuse with this when the editable fields changed since the admin loaded them. */
export const STALE_RECIPE_MESSAGE = "Someone else changed this dish after you opened it. Reload the page to see their changes, then make yours again.";

export const recipeFiltersSchema = z.strictObject({
  q: z.string().trim().max(200).optional(),
  origin: z.enum(RECIPE_ORIGINS).optional(),
  page: z.number().int().min(1).max(100_000).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});
export type RecipeFilters = z.infer<typeof recipeFiltersSchema>;

/** The list page's query string as filters; an unknown value is dropped rather than failing the page. */
export function recipeFiltersFromSearchParams(params: Record<string, string | string[] | undefined>): RecipeFilters {
  const one = (key: string) => {
    const value = params[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const filters: RecipeFilters = {};
  const q = one("q");
  if (q && q.trim().length <= 200) filters.q = q;
  const origin = one("origin");
  if (origin === "curated" || origin === "lookup") filters.origin = origin;
  const page = Number.parseInt(one("page") ?? "", 10);
  if (Number.isInteger(page) && page >= 1 && page <= 100_000) filters.page = page;
  return filters;
}

const ingredientSchema = z.strictObject({
  name: z.string().trim().min(1, "Enter the ingredient").max(100, "Keep the ingredient under 100 characters"),
  masterProductId: z.string().trim().max(200).transform((value) => value || null),
  qty: z
    .string()
    .trim()
    .refine((value) => value === "" || /^\d{1,7}(\.\d{1,3})?$/.test(value), "Enter a number, up to 3 decimals")
    .transform((value) => (value === "" ? null : value))
    .refine((value) => value === null || Number(value) > 0, "Enter a quantity above 0"),
  unit: z.string().trim().max(20, "Keep the unit under 20 characters").transform((value) => value || null),
});

export const recipeFormSchema = z
  .strictObject({
    recipeId: z.string().min(1).max(200),
    version: z.string().min(1).max(200),
    name: z
      .string()
      .trim()
      .min(1, "Enter a name")
      .max(200, "Keep the name under 200 characters")
      .refine((value) => dishKey(value) !== "", "The name needs a letter or a digit"),
    aliases: z.string().max(5000, "Keep the other names under 5,000 characters"),
    servings: z
      .string()
      .trim()
      .refine((value) => value === "" || /^\d{1,3}$/.test(value), "Enter servings as a whole number")
      .transform((value) => (value === "" ? null : Number(value)))
      .refine((value) => value === null || (value >= 1 && value <= 100), "Enter servings between 1 and 100"),
    ingredients: z
      .array(ingredientSchema)
      .min(1, "Add at least one ingredient")
      .max(MAX_RECIPE_INGREDIENTS, `Keep it to ${MAX_RECIPE_INGREDIENTS} ingredients`),
  })
  .superRefine((form, ctx) => {
    for (const line of form.aliases.split("\n")) {
      if (line.trim() && !dishKey(line)) {
        ctx.addIssue({ code: "custom", path: ["aliases"], message: `“${line.trim()}” has no letter or digit` });
        return;
      }
    }
    // Quantities scale by the servings they are for; without servings get_recipe cannot use them.
    if (form.servings === null && form.ingredients.some((row) => row.qty !== null)) {
      ctx.addIssue({ code: "custom", path: ["servings"], message: "Enter the servings these quantities are for" });
    }
  });
export type RecipeForm = z.infer<typeof recipeFormSchema>;

/** Folded other names, one per line: blanks, repeats and the dish's own key dropped. */
export function foldAliases(text: string, key: string): string[] {
  const aliases = text.split("\n").map(dishKey).filter((alias) => alias && alias !== key);
  return [...new Set(aliases)];
}

/** The editor's form as the schema's input. Ingredient fields repeat once per row, in row order. */
export function readRecipeForm(form: FormData): Record<string, unknown> {
  const text = (key: string) => {
    const value = form.get(key);
    return typeof value === "string" ? value : undefined;
  };
  const all = (key: string) => form.getAll(key).map((value) => (typeof value === "string" ? value : ""));
  const names = all("ingredientName");
  const products = all("ingredientProduct");
  const qtys = all("ingredientQty");
  const units = all("ingredientUnit");
  return {
    recipeId: text("recipeId"),
    version: text("version"),
    name: text("name"),
    aliases: text("aliases"),
    servings: text("servings"),
    ingredients: names.map((name, index) => ({
      name,
      masterProductId: products[index] ?? "",
      qty: qtys[index] ?? "",
      unit: units[index] ?? "",
    })),
  };
}
