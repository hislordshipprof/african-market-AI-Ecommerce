"use server";

import { createHash } from "node:crypto";
import { z } from "zod";
import { dishKey, dishKeys } from "../assistant/recipe-base";
import { Prisma, lockRecipeNames, lockRecipeRow, platformAdminTransaction } from "../db";
import { parseInput } from "../security/parse-input";
import { requirePlatformAdmin } from "./session";
import {
  RECIPE_PAGE_SIZE,
  STALE_RECIPE_MESSAGE,
  foldAliases,
  readRecipeForm,
  recipeFiltersSchema,
  recipeFormSchema,
  type RecipeOrigin,
} from "./recipe-base-form";

type Tx = Parameters<Parameters<typeof platformAdminTransaction>[0]>[0];

export type RecipeListRow = {
  id: string;
  name: string;
  origin: RecipeOrigin;
  cuisine: string | null;
  servings: number | null;
  /** Null when none is stored, or when the stored one is not an http(s) link. */
  sourceUrl: string | null;
  ingredientCount: number;
  mappedCount: number;
  createdAt: Date;
};

export type RecipeListPage = { recipes: RecipeListRow[]; total: number; page: number; pageSize: number };

/** Only an http(s) link is handed to the page; a lookup stores a search result URL, but the page never trusts that. */
function safeLink(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Dishes for the admin list, newest first. A search finds a dish the way get_recipe does: exact folded name or other name. */
export async function listRecipeBase(input: unknown): Promise<RecipeListPage> {
  await requirePlatformAdmin();
  const parsed = parseInput(recipeFiltersSchema, input ?? {});
  if (!parsed.ok) return { recipes: [], total: 0, page: 1, pageSize: RECIPE_PAGE_SIZE };
  const { q, origin, page = 1, pageSize = RECIPE_PAGE_SIZE } = parsed.data;
  const keys = q ? dishKeys(q) : [];
  if (q && keys.length === 0) return { recipes: [], total: 0, page, pageSize };

  const where: Prisma.RecipeWhereInput = {
    ...(origin ? { origin } : {}),
    ...(keys.length > 0 ? { OR: [{ key: { in: keys } }, { aliases: { hasSome: keys } }] } : {}),
  };
  const [rows, total] = await platformAdminTransaction((tx) => Promise.all([
    tx.recipe.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, name: true, origin: true, cuisine: true, servings: true, sourceUrl: true, createdAt: true,
        ingredients: { select: { masterProductId: true } },
      },
    }),
    tx.recipe.count({ where }),
  ]));
  return {
    recipes: rows.map(({ ingredients, ...row }) => ({
      ...row,
      origin: row.origin as RecipeOrigin,
      sourceUrl: safeLink(row.sourceUrl),
      ingredientCount: ingredients.length,
      mappedCount: ingredients.filter((item) => item.masterProductId).length,
    })),
    total,
    page,
    pageSize,
  };
}

type IngredientRow = { name: string; masterProductId: string | null; qty: string | null; unit: string | null };
type Snapshot = { name: string; aliases: string[]; servings: number | null; ingredients: IngredientRow[] };

const recipeWithRows = {
  ingredients: { orderBy: { position: "asc" }, include: { masterProduct: { select: { name: true } } } },
} satisfies Prisma.RecipeInclude;
type LoadedRecipe = Prisma.RecipeGetPayload<{ include: typeof recipeWithRows }>;

function snapshot(recipe: LoadedRecipe): Snapshot {
  return {
    name: recipe.name,
    aliases: recipe.aliases,
    servings: recipe.servings,
    ingredients: recipe.ingredients.map((row) => ({
      name: row.name,
      masterProductId: row.masterProductId,
      qty: row.qty == null ? null : row.qty.toString(),
      unit: row.unit,
    })),
  };
}

// Hashes only the editor's fields, so marking a dish curated does not make an open editor stale.
function version(value: Snapshot): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

export type RecipeEditor = {
  recipe: {
    id: string;
    key: string;
    name: string;
    aliases: string[];
    cuisine: string | null;
    servings: number | null;
    sourceUrl: string | null;
    origin: RecipeOrigin;
    createdAt: Date;
    ingredients: Array<IngredientRow & { masterProductName: string | null }>;
    /** The version of the editable fields this form was loaded with; a save from an older version is refused. */
    version: string;
  };
  /** Products a row can be mapped to: every master product that is not archived. */
  products: Array<{ id: string; name: string }>;
};

const idSchema = z.string().min(1).max(200);

/** The editor's data, or null for an unknown dish. */
export async function getRecipeEditor(recipeId: string): Promise<RecipeEditor | null> {
  await requirePlatformAdmin();
  const id = parseInput(idSchema, recipeId);
  if (!id.ok) return null;
  return platformAdminTransaction(async (tx) => {
    const recipe = await tx.recipe.findUnique({ where: { id: id.data }, include: recipeWithRows });
    if (!recipe) return null;
    const products = await tx.masterProduct.findMany({
      where: { status: { not: "archived" } },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    const state = snapshot(recipe);
    return {
      recipe: {
        id: recipe.id,
        key: recipe.key,
        name: recipe.name,
        aliases: recipe.aliases,
        cuisine: recipe.cuisine,
        servings: recipe.servings,
        sourceUrl: safeLink(recipe.sourceUrl),
        origin: recipe.origin as RecipeOrigin,
        createdAt: recipe.createdAt,
        ingredients: state.ingredients.map((row, index) => ({ ...row, masterProductName: recipe.ingredients[index]?.masterProduct?.name ?? null })),
        version: version(state),
      },
      products,
    };
  });
}

export type RecipeSaveState = {
  ok?: boolean;
  message?: string;
  /** Keyed by field: name, aliases, servings, ingredients, or ingredients.<row>.<field>. */
  fieldErrors?: Record<string, string>;
  version?: string;
};

type Session = Awaited<ReturnType<typeof requirePlatformAdmin>>;

async function audit(tx: Tx, session: Session, action: string, recipeId: string, before: object | null, after: object | null) {
  await tx.auditLog.create({
    data: {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action,
      entityType: "recipe",
      entityId: recipeId,
      ...(before ? { before: before as Prisma.InputJsonObject } : {}),
      ...(after ? { after: after as Prisma.InputJsonObject } : {}),
    },
  });
}

const CHECK_FIELDS = "Check the highlighted fields";

/**
 * Saves the editor form. The key is the folded name; neither it nor an other name may be one another dish
 * already answers to (#25's key rules), so get_recipe never has to choose between two dishes for one name.
 */
export async function saveRecipe(_prev: RecipeSaveState, form: FormData): Promise<RecipeSaveState> {
  const session = await requirePlatformAdmin();
  const parsed = recipeFormSchema.safeParse(readRecipeForm(form));
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "recipeId") return { ok: false, message: "Dish not found" };
      if (field === "version") return { ok: false, message: STALE_RECIPE_MESSAGE };
      fieldErrors[issue.path.join(".")] ??= issue.message;
    }
    return { ok: false, message: CHECK_FIELDS, fieldErrors };
  }
  const { recipeId, version: loaded, name, servings, ingredients } = parsed.data;
  const key = dishKey(name);
  const aliases = foldAliases(parsed.data.aliases, key);

  return platformAdminTransaction(async (tx): Promise<RecipeSaveState> => {
    await lockRecipeNames(tx);
    await lockRecipeRow(tx, recipeId);
    const recipe = await tx.recipe.findUnique({ where: { id: recipeId }, include: recipeWithRows });
    if (!recipe) return { ok: false, message: "Dish not found" };
    const before = snapshot(recipe);
    // The form holds every field as it was loaded; saving it over a newer row would undo the other admin's change.
    if (version(before) !== loaded) return { ok: false, message: STALE_RECIPE_MESSAGE };

    const terms = [key, ...aliases];
    const others = await tx.recipe.findMany({
      where: { id: { not: recipeId }, OR: [{ key: { in: terms } }, { aliases: { hasSome: terms } }] },
      select: { key: true, name: true, aliases: true },
    });
    const owner = (term: string) => others.find((row) => row.key === term || row.aliases.includes(term));
    const fieldErrors: Record<string, string> = {};
    const nameOwner = owner(key);
    if (nameOwner) fieldErrors.name = `${nameOwner.name} already answers to this name`;
    const takenAlias = aliases.find((alias) => owner(alias));
    if (takenAlias) fieldErrors.aliases = `“${takenAlias}” already answers to ${owner(takenAlias)?.name}`;

    // A row keeps an archived product it already had; a new mapping must be a product that is not archived.
    const kept = new Set(recipe.ingredients.flatMap((row) => row.masterProductId ?? []));
    const ids = [...new Set(ingredients.flatMap((row) => row.masterProductId ?? []))];
    const found = await tx.masterProduct.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
    const status = new Map(found.map((row) => [row.id, row.status]));
    ingredients.forEach((row, index) => {
      if (!row.masterProductId) return;
      const field = `ingredients.${index}.masterProductId`;
      if (!status.has(row.masterProductId)) fieldErrors[field] = "Choose a product from the list";
      else if (status.get(row.masterProductId) === "archived" && !kept.has(row.masterProductId)) fieldErrors[field] = "This product is archived";
    });
    if (Object.keys(fieldErrors).length > 0) return { ok: false, message: CHECK_FIELDS, fieldErrors };

    const after: Snapshot = {
      name,
      aliases,
      servings,
      ingredients: ingredients.map((row) => ({ ...row, qty: row.qty === null ? null : new Prisma.Decimal(row.qty).toString() })),
    };
    if (version(after) === loaded && key === recipe.key) return { ok: true, message: "No changes to save", version: loaded };

    await tx.recipe.update({ where: { id: recipeId }, data: { key, name, aliases, servings } });
    await tx.recipeIngredient.deleteMany({ where: { recipeId } });
    await tx.recipeIngredient.createMany({
      data: after.ingredients.map((row, position) => ({ recipeId, position, ...row })),
    });
    await audit(tx, session, "catalog.recipe_edit", recipeId, before, after);
    return { ok: true, message: "Saved", version: version(after) };
  });
}

export type RecipeActionState = { ok?: boolean; message?: string };

const idForm = (form: FormData) => parseInput(idSchema, form.get("recipeId"));

/** Marks a looked-up dish curated: when several dishes answer one name, get_recipe prefers a curated one. */
export async function markRecipeCurated(_prev: RecipeActionState, form: FormData): Promise<RecipeActionState> {
  const session = await requirePlatformAdmin();
  const id = idForm(form);
  if (!id.ok) return { ok: false, message: "Dish not found" };
  return platformAdminTransaction(async (tx): Promise<RecipeActionState> => {
    await lockRecipeRow(tx, id.data);
    const recipe = await tx.recipe.findUnique({ where: { id: id.data }, select: { origin: true } });
    if (!recipe) return { ok: false, message: "Dish not found" };
    if (recipe.origin === "curated") return { ok: false, message: "This dish is already curated" };
    await tx.recipe.update({ where: { id: id.data }, data: { origin: "curated" } });
    await audit(tx, session, "catalog.recipe_curate", id.data, { origin: recipe.origin }, { origin: "curated" });
    return { ok: true, message: "Marked curated" };
  });
}

/**
 * Deletes a looked-up dish; the audit row keeps everything it held. The next request for it is looked up online
 * again. A curated dish is never deleted: the seed would bring it back, and the #146 eval reads it.
 */
export async function deleteRecipe(_prev: RecipeActionState, form: FormData): Promise<RecipeActionState> {
  const session = await requirePlatformAdmin();
  const id = idForm(form);
  if (!id.ok) return { ok: false, message: "Dish not found" };
  return platformAdminTransaction(async (tx): Promise<RecipeActionState> => {
    await lockRecipeRow(tx, id.data);
    const recipe = await tx.recipe.findUnique({ where: { id: id.data }, include: recipeWithRows });
    if (!recipe) return { ok: false, message: "Dish not found" };
    if (recipe.origin !== "lookup") return { ok: false, message: "Only a looked-up dish can be deleted. Edit a curated dish instead." };
    await tx.recipe.delete({ where: { id: id.data } });
    await audit(tx, session, "catalog.recipe_delete", id.data, {
      key: recipe.key,
      cuisine: recipe.cuisine,
      sourceUrl: recipe.sourceUrl,
      origin: recipe.origin,
      createdAt: recipe.createdAt.toISOString(),
      ...snapshot(recipe),
    }, null);
    return { ok: true, message: "Deleted" };
  });
}
