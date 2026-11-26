import type { PrismaClient } from "@prisma/client";
import { AISLES } from "../src/lib/catalog/category-tree";
import { catalogFor } from "../src/lib/storefront/catalog";
import { readCategoryAdminChanges, withoutAdminChanges } from "./master-catalog-upsert";

export type SeedCategory = {
  id: string; name: string; slug: string; localName: string; imageUrl: string; sortOrder: number;
  /** Set when the seed creates the category; a later seed leaves where an admin moved it. */
  parentId?: string | null;
  taxCode?: string;
};

const photo = (key: string) => catalogFor(key)?.imageUrl ?? "";

// The 16 aisles, then their subcategories (#861): a parent exists before its children.
const SEEDED_CATEGORIES: SeedCategory[] = [
  ...AISLES.map((aisle, index) => ({
    id: aisle.id, name: aisle.name, slug: aisle.slug, localName: aisle.localName ?? "", imageUrl: photo(aisle.photo),
    sortOrder: index + 1, parentId: null, taxCode: aisle.taxCode,
  })),
  ...AISLES.flatMap((aisle) => aisle.subcategories.map((sub, index) => ({
    id: sub.id, name: sub.name, slug: sub.slug, localName: sub.localName ?? "", imageUrl: photo(sub.photo ?? aisle.photo),
    sortOrder: index + 1, parentId: aisle.id, taxCode: sub.taxCode ?? aisle.taxCode,
  }))),
];

export async function seedCategoryMetadata(client: PrismaClient, categories: SeedCategory[] = SEEDED_CATEGORIES, log: (line: string) => void = console.log) {
  let kept = 0;
  for (const cat of categories) {
    const values = { name: cat.name, slug: cat.slug, localName: cat.localName || null, imageUrl: cat.imageUrl, sortOrder: cat.sortOrder, taxCode: cat.taxCode ?? "txcd_40040000" };
    // A re-seed keeps what a platform admin changed on a category, and leaves a deleted one deleted (#675).
    const keptAdminChanges = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      const changes = await readCategoryAdminChanges(tx, cat.id);
      if (changes.deleted) return true;
      await tx.category.upsert({ where: { id: cat.id }, update: withoutAdminChanges(values, changes), create: { id: cat.id, parentId: cat.parentId ?? null, ...values } });
      return changes.fields.size > 0;
    });
    if (keptAdminChanges) kept++;
  }
  log(`Seeded ${categories.length} categories with localName and imageUrl`);
  log(`Kept admin changes on ${kept} ${kept === 1 ? "category" : "categories"} (the fields, order and deletions an admin changed)`);
}
