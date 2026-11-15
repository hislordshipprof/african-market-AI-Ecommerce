import type { Prisma } from "@prisma/client";
import { createHash } from "crypto";

export interface CsvRow {
  id: string;
  english_name: string;
  local_names: string;
  search_synonyms: string;
  category: string;
  subcategory: string;
  origin_countries: string;
  product_type: string;
  common_brands: string;
  unit: string;
  common_pack_sizes: string;
  typical_weight_g: string;
  storage: string;
  perishable: string;
  description: string;
  image_url: string;
  image_source_page: string;
  image_license: string;
  image_author: string;
  sources: string;
  confidence: string;
  notes: string;
}

export function synonymId(productId: string, prefix: string, ...parts: (string | null | undefined)[]): string {
  const hash = createHash("sha256")
    .update(parts.filter(Boolean).join("|"))
    .digest("hex")
    .substring(0, 12);
  return `${productId}_${prefix}_${hash}`;
}

export function parseLocalNames(raw: string): { term: string; language: string | null; region: string | null }[] {
  if (!raw) return [];
  return raw.split("|").map((entry) => {
    const trimmed = entry.trim();
    const match = trimmed.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (match) {
      const term = match[1].trim();
      const parts = match[2].split(",").map((s) => s.trim());
      const language = parts[0] || null;
      const region = parts[1] || null;
      return { term, language, region };
    }
    return { term: trimmed, language: null, region: null };
  }).filter((s) => s.term.length > 0);
}

export function parseSearchSynonyms(raw: string): { term: string }[] {
  if (!raw) return [];
  return raw
    .split("|")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((term) => ({ term }));
}

/**
 * Make the seed's synonym rows match the CSV row: upsert each one, delete any seeded row it no longer names.
 * A seeded synonym an admin edited or removed (`adminSynonymIds`) is left as the admin left it (#613).
 */
export async function upsertSynonyms(
  tx: Prisma.TransactionClient,
  row: CsvRow,
  adminSynonymIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  const keep: string[] = [];
  for (const syn of parseLocalNames(row.local_names)) {
    const id = synonymId(row.id, "ln", syn.term, syn.language, syn.region);
    keep.push(id);
    if (adminSynonymIds.has(id)) continue;
    await tx.productSynonym.upsert({
      where: { id },
      update: { term: syn.term, language: syn.language, region: syn.region },
      create: { id, productId: row.id, term: syn.term, language: syn.language, region: syn.region },
    });
  }
  for (const syn of parseSearchSynonyms(row.search_synonyms)) {
    const id = synonymId(row.id, "ss", syn.term);
    keep.push(id);
    if (adminSynonymIds.has(id)) continue;
    await tx.productSynonym.upsert({
      where: { id },
      update: { term: syn.term },
      create: { id, productId: row.id, term: syn.term },
    });
  }
  // Prunes only rows the seed created (its derived ids); a synonym added on the admin synonym screen stays (#541).
  const rows = await tx.productSynonym.findMany({ where: { productId: row.id }, select: { id: true } });
  const seeded = (id: string) => id.startsWith(`${row.id}_ln_`) || id.startsWith(`${row.id}_ss_`);
  const stale = rows.map((r) => r.id).filter((id) => seeded(id) && !keep.includes(id) && !adminSynonymIds.has(id));
  if (stale.length > 0) await tx.productSynonym.deleteMany({ where: { id: { in: stale } } });
}

export type MasterProductVariant = {
  /** Status a new row is created with. */
  statusOnCreate: string;
  /** Status written to an existing row. Omit to leave it alone (review path: never undo an approval). */
  statusOnUpdate?: string;
  confidence: string;
  /** Set on create; on update it is written only when non-null, so a re-seed never wipes an image. */
  imageUrl: string | null;
};

/** The master-product columns the seed writes. */
const SEEDED_FIELDS = [
  "name", "categoryId", "description", "imageSourceUrl", "imageAuthor", "imageLicense", "unit", "weightG", "frozen",
  "perishable", "storage", "subcategory", "originCountries", "confidence", "status", "imageUrl",
] as const;
type SeededField = (typeof SEEDED_FIELDS)[number];

/** Statuses only an admin sets. The seed never moves a product out of them; a merged product it leaves whole. */
const ADMIN_STATUSES = new Set(["archived", "rejected"]);

/** Audit actions whose `after` names the master-product columns the admin changed. */
const FIELD_EDIT_ACTIONS = ["catalog.product_edit", "catalog.edit"];
const STATUS_ACTIONS = ["catalog.approve", "catalog.reject"];
const SYNONYM_ACTIONS = ["catalog.synonym_edit", "catalog.synonym_remove"];
const IMAGE_ACTION = "catalog.product_image";

export type AdminChanges = {
  /** Seeded columns a platform admin changed; the seed leaves them as the admin set them. */
  fields: Set<SeededField>;
  /** Synonym rows a platform admin edited or removed; the seed neither rewrites nor recreates them. */
  synonymIds: Set<string>;
};

function jsonObject(value: Prisma.JsonValue | null): Prisma.JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * What platform admins changed on a master product, read from its audit rows (#613). The audit log is
 * the record: every admin write to a seeded column or synonym writes one in the same transaction, and
 * rows written before this change count too, so no marker column or backfill is needed.
 */
export async function readAdminChanges(tx: Prisma.TransactionClient, productId: string): Promise<AdminChanges> {
  const rows = await tx.auditLog.findMany({
    where: {
      entityType: "master_product",
      entityId: productId,
      action: { in: [...FIELD_EDIT_ACTIONS, ...STATUS_ACTIONS, ...SYNONYM_ACTIONS, IMAGE_ACTION] },
    },
    select: { action: true, before: true, after: true },
  });
  const changes: AdminChanges = { fields: new Set(), synonymIds: new Set() };
  const seeded = new Set<string>(SEEDED_FIELDS);
  for (const row of rows) {
    if (FIELD_EDIT_ACTIONS.includes(row.action)) {
      for (const field of Object.keys(jsonObject(row.after))) if (seeded.has(field)) changes.fields.add(field as SeededField);
    } else if (STATUS_ACTIONS.includes(row.action)) {
      changes.fields.add("status");
    } else if (row.action === IMAGE_ACTION) {
      changes.fields.add("imageUrl");
    } else {
      const id = jsonObject(row.before).synonymId ?? jsonObject(row.after).synonymId;
      if (typeof id === "string") changes.synonymIds.add(id);
    }
  }
  return changes;
}

/** The seed's values without the columns an admin changed. */
export function withoutAdminChanges<T extends object>(values: T, changes: { fields: ReadonlySet<string> }): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([field]) => !changes.fields.has(field))) as Partial<T>;
}

/** The category columns the seed writes. */
const SEEDED_CATEGORY_FIELDS = new Set(["name", "slug", "localName", "imageUrl", "sortOrder", "taxCode"]);

export type CategoryAdminChanges = {
  /** Seeded columns a platform admin changed; the seed leaves them as the admin set them. */
  fields: Set<string>;
  /** A platform admin deleted the category; the seed does not recreate it. */
  deleted: boolean;
};

/**
 * What platform admins changed on a seeded category, read from the audit rows #541's category admin writes (#675).
 * A move renumbers the whole sibling group but audits only the moved category, so a move of any sibling keeps
 * the order of every category in the group.
 */
export async function readCategoryAdminChanges(tx: Prisma.TransactionClient, categoryId: string): Promise<CategoryAdminChanges> {
  const rows = await tx.$queryRaw<Array<{ parent_id: string | null }>>`SELECT parent_id FROM categories WHERE id = ${categoryId} FOR UPDATE`;
  const existing = rows[0];
  const audits = await tx.auditLog.findMany({
    where: { entityType: "category", entityId: categoryId, action: { in: ["catalog.category_edit", "catalog.category_image", "catalog.category_delete"] } },
    select: { action: true, after: true },
  });
  const changes: CategoryAdminChanges = { fields: new Set(), deleted: !existing && audits.some((row) => row.action === "catalog.category_delete") };
  for (const row of audits) {
    if (row.action === "catalog.category_image") changes.fields.add("imageUrl");
    if (row.action === "catalog.category_edit") {
      for (const field of Object.keys(jsonObject(row.after))) if (SEEDED_CATEGORY_FIELDS.has(field)) changes.fields.add(field);
    }
  }
  if (existing) {
    const siblings = await tx.category.findMany({ where: { parentId: existing.parent_id }, select: { id: true } });
    const moved = await tx.auditLog.count({
      where: { entityType: "category", action: "catalog.category_move", entityId: { in: siblings.map((row) => row.id) } },
    });
    if (moved > 0) changes.fields.add("sortOrder");
  }
  return changes;
}

/** The seed's category for a product, or null when the category is gone (an admin deleted it). */
export async function existingCategoryId(tx: Prisma.TransactionClient, categoryId: string | null): Promise<string | null> {
  if (!categoryId) return null;
  return (await tx.category.findUnique({ where: { id: categoryId }, select: { id: true } }))?.id ?? null;
}

/** The recipe snapshot fields `catalog.recipe_edit` records; a rename also moves `key`. */
const RECIPE_EDIT_FIELDS = ["key", "name", "aliases", "servings", "ingredients"] as const;

/**
 * The fields platform admins edited on a recipe, from its `catalog.recipe_edit` rows (#675): each holds the whole
 * editor snapshot before and after, so a field counts when its two values differ.
 */
export async function readRecipeAdminChanges(tx: Prisma.TransactionClient, recipeId: string): Promise<{ fields: Set<string> }> {
  const rows = await tx.auditLog.findMany({
    where: { entityType: "recipe", entityId: recipeId, action: "catalog.recipe_edit" },
    select: { before: true, after: true },
  });
  const fields = new Set<string>();
  for (const row of rows) {
    const [before, after] = [jsonObject(row.before), jsonObject(row.after)];
    for (const field of RECIPE_EDIT_FIELDS) if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) fields.add(field);
  }
  return { fields };
}

/**
 * The recipe a seeded dish key names, the row with that key or the one an admin renamed away from it, locked until
 * the seed's transaction ends so an admin save cannot land between the read and the write.
 */
export async function lockSeededRecipe(tx: Prisma.TransactionClient, key: string): Promise<{ id: string } | null> {
  const byKey = await tx.recipe.findUnique({ where: { key }, select: { id: true } });
  const renamed = byKey ? null : await tx.auditLog.findFirst({
    where: { entityType: "recipe", action: "catalog.recipe_edit", before: { path: ["key"], equals: key } },
    orderBy: { createdAt: "desc" },
    select: { entityId: true },
  });
  const id = byKey?.id ?? renamed?.entityId;
  if (!id) return null;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM recipes WHERE id = ${id} FOR UPDATE`;
  return rows[0] ?? null;
}

/** Holds the product's row until the seed's transaction ends, so an admin save cannot land between the read and the write. */
export async function lockMasterProduct(tx: Prisma.TransactionClient, productId: string): Promise<{ status: string } | null> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM master_products WHERE id = ${productId} FOR UPDATE`;
  return rows[0] ?? null;
}

/**
 * Upsert one master-catalog product and its synonyms. The single place that maps a CSV row
 * to `masterProduct` columns; the high-confidence and review paths differ only in `variant`.
 * Runs inside the caller's transaction (which must already be the platform-admin role).
 * An existing product keeps what a platform admin changed (#613): edited columns, its photo, an
 * archived, rejected or merged status, and edited or removed synonyms. A merged product is left whole.
 * Returns whether the seed kept any admin change on it.
 */
export async function upsertMasterProduct(
  tx: Prisma.TransactionClient,
  row: CsvRow,
  categoryId: string | null,
  variant: MasterProductVariant,
): Promise<{ keptAdminChanges: boolean }> {
  const weightG = row.typical_weight_g ? parseInt(row.typical_weight_g, 10) : null;
  const fields = {
    name: row.english_name,
    categoryId,
    description: row.description || null,
    imageSourceUrl: row.image_url?.trim() || null,
    imageAuthor: row.image_author || null,
    imageLicense: row.image_license || null,
    unit: row.unit || null,
    weightG: isNaN(weightG as number) ? null : weightG,
    frozen: row.storage?.trim().toLowerCase() === "frozen",
    perishable: row.perishable?.trim().toLowerCase() === "yes",
    storage: row.storage || null,
    subcategory: row.subcategory || null,
    originCountries: row.origin_countries || null,
    confidence: variant.confidence,
  };

  const existing = await lockMasterProduct(tx, row.id);
  if (existing?.status === "merged") return { keptAdminChanges: true };
  fields.categoryId = await existingCategoryId(tx, categoryId);
  const changes = await readAdminChanges(tx, row.id);
  if (existing && ADMIN_STATUSES.has(existing.status)) changes.fields.add("status");

  await tx.masterProduct.upsert({
    where: { id: row.id },
    update: withoutAdminChanges({
      ...fields,
      ...(variant.statusOnUpdate !== undefined ? { status: variant.statusOnUpdate } : {}),
      ...(variant.imageUrl !== null ? { imageUrl: variant.imageUrl } : {}),
    }, changes),
    create: { id: row.id, ...fields, status: variant.statusOnCreate, imageUrl: variant.imageUrl },
  });
  await upsertSynonyms(tx, row, changes.synonymIds);
  return { keptAdminChanges: changes.fields.size > 0 || changes.synonymIds.size > 0 };
}
