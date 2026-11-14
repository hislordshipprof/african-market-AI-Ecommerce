"use server";

import { createHash } from "node:crypto";
import { uploadCatalogPhoto } from "../catalog-image";
import { PHOTO_UPLOAD_MAX_BYTES } from "../listing/csv-file-cap";
import { Prisma, lockMasterProductRow, platformAdminRawQuery, platformAdminTransaction, storesListingMasterProduct } from "../db";
import { parseInput } from "../security/parse-input";
import { revalidateStorefront } from "../storefront/cache";
import { listingRelevanceJoin, listingRelevanceWhere } from "../storefront/search-relevance";
import { requirePlatformAdmin } from "./session";
import { z } from "zod";
import {
  CATALOG_PAGE_SIZE,
  catalogFiltersSchema,
  masterProductFormSchema,
  readMasterProductForm,
  type MasterProductField,
  type MasterStatus,
} from "./master-catalog-form";

export type CatalogRow = {
  id: string;
  name: string;
  status: MasterStatus;
  categoryName: string | null;
  subcategory: string | null;
  unit: string | null;
  weightG: number | null;
  imageUrl: string | null;
  attributesReviewed: boolean;
};

export type CatalogPage = { products: CatalogRow[]; total: number; page: number; pageSize: number };

/** Master products for the admin list: the storefront's catalog search (no LIKE or regex), filters and paging. */
export async function listMasterCatalog(input: unknown): Promise<CatalogPage> {
  await requirePlatformAdmin();
  const parsed = parseInput(catalogFiltersSchema, input ?? {});
  if (!parsed.ok) return { products: [], total: 0, page: 1, pageSize: CATALOG_PAGE_SIZE };
  const filters = parsed.data;
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? CATALOG_PAGE_SIZE;
  const q = filters.q ?? "";

  const where: Prisma.Sql[] = [];
  if (q) where.push(listingRelevanceWhere(q));
  if (filters.category) where.push(Prisma.sql`mp.category_id = ${filters.category}`);
  if (filters.status) where.push(Prisma.sql`mp.status = ${filters.status}`);
  if (filters.photo === "missing") where.push(Prisma.sql`mp.image_url IS NULL`);
  const allReviewed = Prisma.sql`(mp.ingredients_status = 'reviewed' AND mp.allergens_status = 'reviewed' AND mp.dietary_status = 'reviewed')`;
  if (filters.attributes === "reviewed") where.push(allReviewed);
  if (filters.attributes === "unreviewed") where.push(Prisma.sql`NOT ${allReviewed}`);

  const from = Prisma.sql`
    FROM master_products mp
    LEFT JOIN categories c ON c.id = mp.category_id
    ${q ? Prisma.sql`CROSS JOIN LATERAL (SELECT NULL::text AS custom_name) l ${listingRelevanceJoin(q)}` : Prisma.empty}
    ${where.length > 0 ? Prisma.sql`WHERE ${Prisma.join(where, " AND ")}` : Prisma.empty}
  `;
  const order = q
    ? Prisma.sql`ORDER BY relevance.rank, relevance.fuzzy DESC, LOWER(mp.name), mp.id`
    : Prisma.sql`ORDER BY LOWER(mp.name), mp.id`;

  type Row = {
    id: string;
    name: string;
    status: MasterStatus;
    category_name: string | null;
    subcategory: string | null;
    unit: string | null;
    weight_g: number | null;
    image_url: string | null;
    attributes_reviewed: boolean;
  };
  const [rows, counted] = await Promise.all([
    platformAdminRawQuery<Row>(Prisma.sql`
      SELECT mp.id, mp.name, mp.status, c.name AS category_name, mp.subcategory, mp.unit, mp.weight_g, mp.image_url,
        ${allReviewed} AS attributes_reviewed
      ${from}
      ${order}
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `),
    platformAdminRawQuery<{ total: number }>(Prisma.sql`SELECT COUNT(*)::int AS total ${from}`),
  ]);
  const total = counted[0]?.total ?? 0;

  return {
    products: rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      categoryName: row.category_name,
      subcategory: row.subcategory,
      unit: row.unit,
      weightG: row.weight_g,
      imageUrl: row.image_url,
      attributesReviewed: row.attributes_reviewed,
    })),
    total,
    page,
    pageSize,
  };
}

export type MasterProductEditor = {
  product: {
    id: string;
    name: string;
    categoryId: string | null;
    subcategory: string | null;
    description: string | null;
    unit: string | null;
    weightG: number | null;
    frozen: boolean;
    perishable: boolean;
    storage: string | null;
    status: MasterStatus;
    imageUrl: string | null;
    ingredientsStatus: string;
    allergensStatus: string;
    dietaryStatus: string;
    updatedAt: Date;
    /** The version of the editable fields this form was loaded with; a save from an older version is refused. */
    version: string;
  };
  categories: Array<{ id: string; name: string }>;
  storeCount: number;
};

/** The editor's data, or null for an unknown product. */
export async function getMasterProductEditor(productId: string): Promise<MasterProductEditor | null> {
  await requirePlatformAdmin();
  const id = parseInput(z.string().min(1).max(200), productId);
  if (!id.ok) return null;
  return platformAdminTransaction(async (tx) => {
    const product = await tx.masterProduct.findUnique({
      where: { id: id.data },
      select: {
        id: true, name: true, categoryId: true, subcategory: true, description: true, unit: true, weightG: true,
        frozen: true, perishable: true, storage: true, status: true, imageUrl: true,
        ingredientsStatus: true, allergensStatus: true, dietaryStatus: true, updatedAt: true,
      },
    });
    if (!product) return null;
    const categories = await tx.category.findMany({ select: { id: true, name: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
    const storeCount = (await storesListingMasterProduct(tx, product.id)).length;
    return { product: { ...product, status: product.status as MasterStatus, version: detailsVersion(product) }, categories, storeCount };
  });
}

/** Categories for the list filter. */
export async function listCatalogCategories(): Promise<Array<{ id: string; name: string }>> {
  await requirePlatformAdmin();
  return platformAdminTransaction((tx) =>
    tx.category.findMany({ select: { id: true, name: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }));
}

export type SaveState = {
  ok?: boolean;
  message?: string;
  fieldErrors?: Partial<Record<MasterProductField, string>>;
  /** The details' version after a successful save, for the editor's next save. */
  version?: string;
};

const EDITED_FIELDS = [
  "name", "categoryId", "subcategory", "description", "unit", "weightG", "frozen", "perishable", "storage", "status",
] as const satisfies readonly MasterProductField[];

const STALE_MESSAGE = "Someone else changed this product after you opened it. Reload the page to see their changes, then make yours again.";

// Hashes only the editor's fields, so a photo upload or attribute review does not make an open editor stale.
function detailsVersion(product: Record<(typeof EDITED_FIELDS)[number], unknown>): string {
  return createHash("sha256").update(JSON.stringify(EDITED_FIELDS.map((field) => product[field]))).digest("base64url");
}

/** Saves the editor form. Archive is the status "archived"; a master product is never deleted. */
export async function saveMasterProduct(_prev: SaveState, form: FormData): Promise<SaveState> {
  const session = await requirePlatformAdmin();
  const parsed = masterProductFormSchema.safeParse(readMasterProductForm(form));
  if (!parsed.success) {
    const fieldErrors: SaveState["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as MasterProductField | "productId" | "version";
      if (field === "productId") return { ok: false, message: "Product not found" };
      if (field === "version") return { ok: false, message: STALE_MESSAGE };
      fieldErrors[field] ??= issue.message;
    }
    return { ok: false, message: "Check the highlighted fields", fieldErrors };
  }
  const { productId, version, ...next } = parsed.data;

  const result = await platformAdminTransaction(async (tx): Promise<SaveState & { storeIds?: string[] }> => {
    await lockMasterProductRow(tx, productId);
    const product = await tx.masterProduct.findUnique({ where: { id: productId } });
    if (!product) return { ok: false, message: "Product not found" };
    // The form holds every field as it was loaded; saving it over a newer row would undo the other admin's change.
    if (detailsVersion(product) !== version) return { ok: false, message: STALE_MESSAGE };
    if (next.categoryId && next.categoryId !== product.categoryId) {
      const category = await tx.category.findUnique({ where: { id: next.categoryId }, select: { id: true } });
      if (!category) return { ok: false, message: "Check the highlighted fields", fieldErrors: { categoryId: "Choose a category from the list" } };
    }

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const field of EDITED_FIELDS) {
      if (product[field] !== next[field]) {
        before[field] = product[field];
        after[field] = next[field];
      }
    }
    if (Object.keys(after).length === 0) return { ok: true, message: "No changes to save", version };

    await tx.masterProduct.update({ where: { id: productId }, data: after });
    await tx.auditLog.create({
      data: {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "catalog.product_edit",
        entityType: "master_product",
        entityId: productId,
        before: before as Prisma.InputJsonObject,
        after: after as Prisma.InputJsonObject,
      },
    });
    return { ok: true, message: "Saved", version: detailsVersion(next), storeIds: await storesListingMasterProduct(tx, productId) };
  });

  const { storeIds, ...state } = result;
  for (const storeId of storeIds ?? []) revalidateStorefront(storeId);
  return state;
}

export type ImageState = { ok?: boolean; message?: string };

const PHOTO_MESSAGES = {
  svg: "SVG images are not accepted. Upload a JPEG, PNG or WebP photo.",
  not_photo: "Upload a JPEG, PNG or WebP photo.",
  storage: "Photo storage is not set up.",
  upload: "The photo could not be saved. Try again.",
} as const;

/** Replaces the product's photo. The old object stays in R2 until a prune removes unreferenced keys. */
export async function uploadMasterProductImage(_prev: ImageState, form: FormData): Promise<ImageState> {
  const session = await requirePlatformAdmin();
  const id = parseInput(z.string().min(1).max(200), form.get("productId"));
  if (!id.ok) return { ok: false, message: "Product not found" };
  const image = form.get("image");
  if (!(image instanceof File) || image.size === 0) return { ok: false, message: "Choose a photo to upload." };
  if (image.size > PHOTO_UPLOAD_MAX_BYTES) return { ok: false, message: "The photo is over 2 MB. Choose a smaller one." };

  const exists = await platformAdminTransaction((tx) => tx.masterProduct.findUnique({ where: { id: id.data }, select: { id: true } }));
  if (!exists) return { ok: false, message: "Product not found" };

  const uploaded = await uploadCatalogPhoto(id.data, new Uint8Array(await image.arrayBuffer()));
  if (!uploaded.ok) return { ok: false, message: PHOTO_MESSAGES[uploaded.reason] };

  const result = await platformAdminTransaction(async (tx): Promise<ImageState & { storeIds?: string[] }> => {
    await lockMasterProductRow(tx, id.data);
    const product = await tx.masterProduct.findUnique({ where: { id: id.data }, select: { imageUrl: true } });
    if (!product) return { ok: false, message: "Product not found" };
    await tx.masterProduct.update({ where: { id: id.data }, data: { imageUrl: uploaded.url } });
    await tx.auditLog.create({
      data: {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "catalog.product_image",
        entityType: "master_product",
        entityId: id.data,
        before: { imageUrl: product.imageUrl },
        after: { imageUrl: uploaded.url },
      },
    });
    return { ok: true, message: "Photo updated", storeIds: await storesListingMasterProduct(tx, id.data) };
  });

  const { storeIds, ...state } = result;
  for (const storeId of storeIds ?? []) revalidateStorefront(storeId);
  return state;
}
