"use server";

import { Prisma, lockMasterProductRow, platformAdminTransaction } from "../db";
import { parseInput } from "../security/parse-input";
import { revalidateStorefront } from "../storefront/cache";
import { listingRelevanceJoin, listingRelevanceWhere } from "../storefront/search-relevance";
import { requirePlatformAdmin } from "./session";
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
  const { rows, total } = await platformAdminTransaction(async (tx) => {
    const found = await tx.$queryRaw<Row[]>`
      SELECT mp.id, mp.name, mp.status, c.name AS category_name, mp.subcategory, mp.unit, mp.weight_g, mp.image_url,
        ${allReviewed} AS attributes_reviewed
      ${from}
      ${order}
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `;
    const counted = await tx.$queryRaw<Array<{ total: number }>>`SELECT COUNT(*)::int AS total ${from}`;
    return { rows: found, total: counted[0]?.total ?? 0 };
  });

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

export type SaveState = { ok?: boolean; message?: string; fieldErrors?: Partial<Record<MasterProductField, string>> };

const EDITED_FIELDS = [
  "name", "categoryId", "subcategory", "description", "unit", "weightG", "frozen", "perishable", "storage", "status",
] as const satisfies readonly MasterProductField[];

/** Stores whose storefront shows this product, read inside the caller's transaction. */
async function storesListing(tx: Pick<Prisma.TransactionClient, "$queryRaw">, productId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ store_id: string }>>`
    SELECT DISTINCT store_id FROM listings WHERE master_product_id = ${productId}`;
  return rows.map((row) => row.store_id);
}

/** Saves the editor form. Archive is the status "archived"; a master product is never deleted. */
export async function saveMasterProduct(_prev: SaveState, form: FormData): Promise<SaveState> {
  const session = await requirePlatformAdmin();
  const parsed = masterProductFormSchema.safeParse(readMasterProductForm(form));
  if (!parsed.success) {
    const fieldErrors: SaveState["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as MasterProductField | "productId";
      if (field === "productId") return { ok: false, message: "Product not found" };
      fieldErrors[field] ??= issue.message;
    }
    return { ok: false, message: "Check the highlighted fields", fieldErrors };
  }
  const { productId, ...next } = parsed.data;

  const result = await platformAdminTransaction(async (tx): Promise<SaveState & { storeIds?: string[] }> => {
    await lockMasterProductRow(tx, productId);
    const product = await tx.masterProduct.findUnique({ where: { id: productId } });
    if (!product) return { ok: false, message: "Product not found" };
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
    if (Object.keys(after).length === 0) return { ok: true, message: "No changes to save" };

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
    return { ok: true, message: "Saved", storeIds: await storesListing(tx, productId) };
  });

  const { storeIds, ...state } = result;
  for (const storeId of storeIds ?? []) revalidateStorefront(storeId);
  return state;
}
