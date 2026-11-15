"use server";

import { z } from "zod";
import { uploadCatalogPhoto } from "../catalog-image";
import { PHOTO_UPLOAD_MAX_BYTES } from "../listing/csv-file-cap";
import { lockCategoryRows, platformAdminTransaction, storesListingCategories } from "../db";
import { parseInput } from "../security/parse-input";
import { revalidateStorefront } from "../storefront/cache";
import { requirePlatformAdmin } from "./session";
import { categoryFormSchema, categorySlug, readCategoryForm, type CategoryField, type CategoryForm } from "./catalog-structure-form";

export type CategoryNode = {
  id: string;
  name: string;
  slug: string;
  localName: string | null;
  imageUrl: string | null;
  parentId: string | null;
  productCount: number;
  children: CategoryNode[];
};

export type CategoryState = { ok?: boolean; message?: string; fieldErrors?: Partial<Record<CategoryField, string>> };

type Tx = Parameters<Parameters<typeof platformAdminTransaction>[0]>[0];
type Session = Awaited<ReturnType<typeof requirePlatformAdmin>>;
type Result = CategoryState & { storeIds?: string[] };

const SIBLING_ORDER = [{ sortOrder: "asc" as const }, { name: "asc" as const }, { id: "asc" as const }];
const idSchema = z.string().min(1).max(200);

/** Top-level categories in order, each with its subcategories in order. The tree is one level deep. */
export async function listCategoryTree(): Promise<CategoryNode[]> {
  await requirePlatformAdmin();
  const rows = await platformAdminTransaction((tx) =>
    tx.category.findMany({
      orderBy: SIBLING_ORDER,
      select: {
        id: true, name: true, slug: true, localName: true, imageUrl: true, parentId: true,
        _count: { select: { masterProducts: true } },
      },
    }));
  const node = ({ _count, ...row }: (typeof rows)[number]): CategoryNode => ({ ...row, productCount: _count.masterProducts, children: [] });
  const top = rows.filter((row) => !row.parentId).map(node);
  const byId = new Map(top.map((category) => [category.id, category]));
  for (const row of rows) if (row.parentId) byId.get(row.parentId)?.children.push(node(row));
  return top;
}

function refused(field: CategoryField, message: string): CategoryState {
  return { ok: false, message: "Check the highlighted fields", fieldErrors: { [field]: message } };
}

function parseCategory(form: FormData): { ok: true; data: CategoryForm } | { ok: false; state: CategoryState } {
  const parsed = categoryFormSchema.safeParse(readCategoryForm(form));
  if (parsed.success) return { ok: true, data: parsed.data };
  const fieldErrors: CategoryState["fieldErrors"] = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === "name" || field === "localName" || field === "parentId") fieldErrors[field] ??= issue.message;
    else return { ok: false, state: { ok: false, message: "Category not found" } };
  }
  return { ok: false, state: { ok: false, message: "Check the highlighted fields", fieldErrors } };
}

async function audit(tx: Tx, session: Session, action: string, categoryId: string, before: object | null, after: object | null) {
  await tx.auditLog.create({
    data: {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action,
      entityType: "category",
      entityId: categoryId,
      ...(before ? { before: before as Record<string, string | number | null> } : {}),
      ...(after ? { after: after as Record<string, string | number | null> } : {}),
    },
  });
}

function finish(result: Result): CategoryState {
  const { storeIds, ...state } = result;
  for (const storeId of storeIds ?? []) revalidateStorefront(storeId);
  return state;
}

// Whole-name comparison in code: Prisma's case-insensitive equals is an ILIKE, which reads % and _ as patterns.
async function nameTaken(tx: Tx, name: string, exceptId: string | null): Promise<boolean> {
  const folded = name.toLocaleLowerCase("en-US");
  const all = await tx.category.findMany({ select: { id: true, name: true } });
  return all.some((row) => row.id !== exceptId && row.name.toLocaleLowerCase("en-US") === folded);
}

function isUniqueClash(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "P2002";
}

/** Two admins saving one name at once: the database's unique name decides, and the loser sees the field error. */
async function withNameClash(run: () => Promise<Result>): Promise<Result> {
  try {
    return await run();
  } catch (error) {
    if (isUniqueClash(error)) return refused("name", "A category already has this name");
    throw error;
  }
}

/** Refuses a parent that would make the tree deeper than one level. Call with both rows locked. */
async function parentProblem(tx: Tx, categoryId: string | null, parentId: string): Promise<string | null> {
  if (parentId === categoryId) return "A category cannot be its own parent";
  const parent = await tx.category.findUnique({ where: { id: parentId }, select: { parentId: true } });
  if (!parent) return "Choose a parent from the list";
  if (parent.parentId) return "Choose a top-level category: subcategories cannot have their own";
  if (categoryId && (await tx.category.count({ where: { parentId: categoryId } })) > 0) {
    return "This category has subcategories, so it stays top level";
  }
  return null;
}

/** Creates a category, last among its siblings. Its slug comes from the name and stays when it is renamed. */
export async function createCategory(_prev: CategoryState, form: FormData): Promise<CategoryState> {
  const session = await requirePlatformAdmin();
  const parsed = parseCategory(form);
  if (!parsed.ok) return parsed.state;
  const { name, localName, parentId } = parsed.data;

  return finish(await withNameClash(() => platformAdminTransaction(async (tx): Promise<Result> => {
    if (parentId) {
      await lockCategoryRows(tx, [parentId]);
      const problem = await parentProblem(tx, null, parentId);
      if (problem) return refused("parentId", problem);
    }
    if (await nameTaken(tx, name, null)) return refused("name", "A category already has this name");
    const base = categorySlug(name);
    let slug = base;
    for (let n = 2; await tx.category.findUnique({ where: { slug }, select: { id: true } }); n++) slug = `${base}-${n}`;
    const last = await tx.category.aggregate({ where: { parentId }, _max: { sortOrder: true } });
    const sortOrder = (last._max.sortOrder ?? 0) + 1;
    const created = await tx.category.create({ data: { name, slug, localName, parentId, sortOrder } });
    await audit(tx, session, "catalog.category_create", created.id, null, { name, slug, localName, parentId, sortOrder });
    return { ok: true, message: "Category added" };
  })));
}

/** Renames a category, sets its local name, or moves it under a parent (or back to the top level). */
export async function updateCategory(_prev: CategoryState, form: FormData): Promise<CategoryState> {
  const session = await requirePlatformAdmin();
  const parsed = parseCategory(form);
  if (!parsed.ok) return parsed.state;
  const { categoryId, name, localName, parentId } = parsed.data;
  if (!categoryId) return { ok: false, message: "Category not found" };

  return finish(await withNameClash(() => platformAdminTransaction(async (tx): Promise<Result> => {
    await lockCategoryRows(tx, parentId ? [categoryId, parentId] : [categoryId]);
    const category = await tx.category.findUnique({ where: { id: categoryId } });
    if (!category) return { ok: false, message: "Category not found" };
    if (parentId && parentId !== category.parentId) {
      const problem = await parentProblem(tx, categoryId, parentId);
      if (problem) return refused("parentId", problem);
    }
    if (name !== category.name && (await nameTaken(tx, name, categoryId))) return refused("name", "A category already has this name");

    const next = { name, localName, parentId };
    const before: Record<string, string | number | null> = {};
    const after: Record<string, string | number | null> = {};
    for (const field of ["name", "localName", "parentId"] as const) {
      if (category[field] !== next[field]) {
        before[field] = category[field];
        after[field] = next[field];
      }
    }
    if (Object.keys(after).length === 0) return { ok: true, message: "No changes to save" };
    if ("parentId" in after) {
      const last = await tx.category.aggregate({ where: { parentId }, _max: { sortOrder: true } });
      after.sortOrder = (last._max.sortOrder ?? 0) + 1;
      before.sortOrder = category.sortOrder;
    }
    await tx.category.update({ where: { id: categoryId }, data: after });
    await audit(tx, session, "catalog.category_edit", categoryId, before, after);
    return { ok: true, message: "Saved", storeIds: await storesListingCategories(tx, [categoryId]) };
  })));
}

/** Moves a category one place up or down among its siblings. Already first or last: nothing changes. */
export async function moveCategory(categoryId: string, direction: "up" | "down"): Promise<CategoryState> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(z.strictObject({ categoryId: idSchema, direction: z.enum(["up", "down"]) }), { categoryId, direction });
  if (!parsed.ok) return { ok: false, message: "Category not found" };
  const id = parsed.data.categoryId;

  return finish(await platformAdminTransaction(async (tx): Promise<Result> => {
    const category = await tx.category.findUnique({ where: { id }, select: { parentId: true } });
    if (!category) return { ok: false, message: "Category not found" };
    const siblingIds = (await tx.category.findMany({ where: { parentId: category.parentId }, select: { id: true } })).map((row) => row.id);
    await lockCategoryRows(tx, siblingIds);
    const siblings = await tx.category.findMany({ where: { parentId: category.parentId }, orderBy: SIBLING_ORDER, select: { id: true, sortOrder: true } });
    const from = siblings.findIndex((row) => row.id === id);
    if (from === -1) return { ok: false, message: "Someone else moved this category. Reload the page." };
    const to = parsed.data.direction === "up" ? from - 1 : from + 1;
    if (to < 0 || to >= siblings.length) return { ok: true, message: "No changes to save" };

    // Renumber the sibling group in its new order, keeping the values it already used where they are distinct.
    const values = siblings.map((row) => row.sortOrder);
    const distinct = new Set(values).size === values.length ? values : siblings.map((_, i) => values[0] + i);
    const order = [...siblings];
    [order[from], order[to]] = [order[to], order[from]];
    for (const [i, row] of order.entries()) {
      if (row.sortOrder !== distinct[i]) await tx.category.update({ where: { id: row.id }, data: { sortOrder: distinct[i] } });
    }
    await audit(tx, session, "catalog.category_move", id, { position: from + 1 }, { position: to + 1, direction: parsed.data.direction });
    return { ok: true, message: "Moved", storeIds: await storesListingCategories(tx, order.map((row) => row.id)) };
  }));
}

/** Deletes a category that has no products and no subcategories. The database refuses the rest too. */
export async function deleteCategory(_prev: CategoryState, form: FormData): Promise<CategoryState> {
  const session = await requirePlatformAdmin();
  const id = parseInput(idSchema, form.get("categoryId"));
  if (!id.ok) return { ok: false, message: "Category not found" };

  return finish(await platformAdminTransaction(async (tx): Promise<Result> => {
    await lockCategoryRows(tx, [id.data]);
    const category = await tx.category.findUnique({
      where: { id: id.data },
      include: { _count: { select: { masterProducts: true, children: true } } },
    });
    if (!category) return { ok: false, message: "Category not found" };
    const products = category._count.masterProducts;
    if (products > 0) {
      return { ok: false, message: `${products} ${products === 1 ? "product is" : "products are"} in this category. Move them to another category first.` };
    }
    if (category._count.children > 0) return { ok: false, message: "This category has subcategories. Move or delete them first." };
    await tx.category.delete({ where: { id: id.data } });
    const { name, slug, localName, imageUrl, parentId, sortOrder } = category;
    await audit(tx, session, "catalog.category_delete", id.data, { name, slug, localName, imageUrl, parentId, sortOrder }, null);
    return { ok: true, message: "Category deleted" };
  }));
}

const PHOTO_MESSAGES = {
  svg: "SVG images are not accepted. Upload a JPEG, PNG or WebP photo.",
  not_photo: "Upload a JPEG, PNG or WebP photo.",
  storage: "Photo storage is not set up.",
  upload: "The photo could not be saved. Try again.",
} as const;

/** Replaces the category's photo, through the same checks and WebP re-encode as a product photo. */
export async function uploadCategoryImage(_prev: CategoryState, form: FormData): Promise<CategoryState> {
  const session = await requirePlatformAdmin();
  const id = parseInput(idSchema, form.get("categoryId"));
  if (!id.ok) return { ok: false, message: "Category not found" };
  const image = form.get("image");
  if (!(image instanceof File) || image.size === 0) return { ok: false, message: "Choose a photo to upload." };
  if (image.size > PHOTO_UPLOAD_MAX_BYTES) return { ok: false, message: "The photo is over 2 MB. Choose a smaller one." };

  const exists = await platformAdminTransaction((tx) => tx.category.findUnique({ where: { id: id.data }, select: { id: true } }));
  if (!exists) return { ok: false, message: "Category not found" };

  const uploaded = await uploadCatalogPhoto(id.data, new Uint8Array(await image.arrayBuffer()));
  if (!uploaded.ok) return { ok: false, message: PHOTO_MESSAGES[uploaded.reason] };

  return finish(await platformAdminTransaction(async (tx): Promise<Result> => {
    await lockCategoryRows(tx, [id.data]);
    const category = await tx.category.findUnique({ where: { id: id.data }, select: { imageUrl: true } });
    if (!category) return { ok: false, message: "Category not found" };
    await tx.category.update({ where: { id: id.data }, data: { imageUrl: uploaded.url } });
    await audit(tx, session, "catalog.category_image", id.data, { imageUrl: category.imageUrl }, { imageUrl: uploaded.url });
    return { ok: true, message: "Photo updated", storeIds: await storesListingCategories(tx, [id.data]) };
  }));
}
