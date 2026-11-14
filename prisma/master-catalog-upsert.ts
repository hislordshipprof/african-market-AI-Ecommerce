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

/** Make the product's synonym rows match the CSV row: upsert each one, delete any it no longer names. */
export async function upsertSynonyms(tx: Prisma.TransactionClient, row: CsvRow): Promise<void> {
  const keep: string[] = [];
  for (const syn of parseLocalNames(row.local_names)) {
    const id = synonymId(row.id, "ln", syn.term, syn.language, syn.region);
    keep.push(id);
    await tx.productSynonym.upsert({
      where: { id },
      update: { term: syn.term, language: syn.language, region: syn.region },
      create: { id, productId: row.id, term: syn.term, language: syn.language, region: syn.region },
    });
  }
  for (const syn of parseSearchSynonyms(row.search_synonyms)) {
    const id = synonymId(row.id, "ss", syn.term);
    keep.push(id);
    await tx.productSynonym.upsert({
      where: { id },
      update: { term: syn.term },
      create: { id, productId: row.id, term: syn.term },
    });
  }
  await tx.productSynonym.deleteMany({ where: { productId: row.id, id: { notIn: keep } } });
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

/**
 * Upsert one master-catalog product and its synonyms. The single place that maps a CSV row
 * to `masterProduct` columns; the high-confidence and review paths differ only in `variant`.
 * Runs inside the caller's transaction (which must already be the platform-admin role).
 */
export async function upsertMasterProduct(
  tx: Prisma.TransactionClient,
  row: CsvRow,
  categoryId: string | null,
  variant: MasterProductVariant,
): Promise<void> {
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

  await tx.masterProduct.upsert({
    where: { id: row.id },
    update: {
      ...fields,
      ...(variant.statusOnUpdate !== undefined ? { status: variant.statusOnUpdate } : {}),
      ...(variant.imageUrl !== null ? { imageUrl: variant.imageUrl } : {}),
    },
    create: { id: row.id, ...fields, status: variant.statusOnCreate, imageUrl: variant.imageUrl },
  });

  await upsertSynonyms(tx, row);
}
