import type { PrismaClient } from "@prisma/client";
import { categoryPhotos } from "../src/lib/storefront/catalog";
import { readCategoryAdminChanges, withoutAdminChanges } from "./master-catalog-upsert";

export type SeedCategory = { id: string; name: string; slug: string; localName: string; imageUrl: string; sortOrder: number };

const SEEDED_CATEGORIES: SeedCategory[] = [
  { id: "cat_tubers", name: "Tubers & Roots", slug: "tubers-and-roots", localName: "ISU · BAYERE", imageUrl: categoryPhotos["tubers-and-roots"], sortOrder: 1 },
  { id: "cat_grains", name: "Grains & Flours", slug: "grains-and-flours", localName: "OKA · AGBADO", imageUrl: categoryPhotos["grains-and-flours"], sortOrder: 2 },
  { id: "cat_spices", name: "Spices & Seasonings", slug: "spices-and-seasonings", localName: "OSE · YAJI", imageUrl: categoryPhotos["spices-and-seasonings"], sortOrder: 3 },
  { id: "cat_oils", name: "Oils & Butters", slug: "oils-and-butters", localName: "NKWU · ORI", imageUrl: categoryPhotos["oils-and-butters"], sortOrder: 4 },
  { id: "cat_vegetables", name: "Vegetables", slug: "vegetables", localName: "EFO · AHIHARA", imageUrl: categoryPhotos["vegetables"], sortOrder: 5 },
  { id: "cat_fish_meat", name: "Fish & Meat", slug: "fish-and-meat", localName: "EJA · ERAN", imageUrl: categoryPhotos["fish-and-meat"], sortOrder: 6 },
  { id: "cat_frozen", name: "Frozen", slug: "frozen", localName: "", imageUrl: categoryPhotos.frozen, sortOrder: 7 },
  { id: "cat_snacks", name: "Snacks", slug: "snacks", localName: "IPANU", imageUrl: categoryPhotos["snacks"], sortOrder: 8 },
  { id: "cat_drinks", name: "Drinks", slug: "drinks", localName: "OMU · ZOBO", imageUrl: categoryPhotos["drinks"], sortOrder: 9 },
  { id: "cat_beauty", name: "Beauty", slug: "beauty", localName: "", imageUrl: categoryPhotos.beauty, sortOrder: 10 },
  { id: "cat_pantry", name: "Pantry Staples", slug: "pantry-staples", localName: "ILE IDANA", imageUrl: categoryPhotos["pantry-staples"], sortOrder: 11 },
  { id: "cat_beans_legumes", name: "Beans & Legumes", slug: "beans-and-legumes", localName: "EWA · WAKE", imageUrl: categoryPhotos["grains-and-flours"], sortOrder: 12 },
  { id: "cat_breakfast_dairy", name: "Breakfast & Dairy", slug: "breakfast-and-dairy", localName: "", imageUrl: categoryPhotos["pantry-staples"], sortOrder: 13 },
  { id: "cat_canned_packaged", name: "Canned & Packaged", slug: "canned-and-packaged", localName: "", imageUrl: categoryPhotos["pantry-staples"], sortOrder: 14 },
  { id: "cat_fruits", name: "Fruits", slug: "fruits", localName: "ESO · MANGO", imageUrl: categoryPhotos.vegetables, sortOrder: 15 },
  { id: "cat_household", name: "Household", slug: "household", localName: "", imageUrl: categoryPhotos.beauty, sortOrder: 16 },
  { id: "cat_seasonings_sauces", name: "Seasonings & Sauces", slug: "seasonings-and-sauces", localName: "OBE · DINDIN", imageUrl: categoryPhotos["spices-and-seasonings"], sortOrder: 17 },
];

export async function seedCategoryMetadata(client: PrismaClient, categories: SeedCategory[] = SEEDED_CATEGORIES, log: (line: string) => void = console.log) {
  // Stripe tax codes (#65), as the sales_tax migration sets them on existing databases.
  const taxCodes: Record<string, string> = { snacks: "txcd_40070005", drinks: "txcd_41040008", beauty: "txcd_32050025", household: "txcd_99999999" };
  let kept = 0;
  for (const cat of categories) {
    const taxCode = taxCodes[cat.slug] ?? "txcd_40040000";
    const values = { name: cat.name, slug: cat.slug, localName: cat.localName || null, imageUrl: cat.imageUrl, sortOrder: cat.sortOrder, taxCode };
    // A re-seed keeps what a platform admin changed on a category, and leaves a deleted one deleted (#675).
    const keptAdminChanges = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      const changes = await readCategoryAdminChanges(tx, cat.id);
      if (changes.deleted) return true;
      await tx.category.upsert({ where: { id: cat.id }, update: withoutAdminChanges(values, changes), create: { id: cat.id, ...values } });
      return changes.fields.size > 0;
    });
    if (keptAdminChanges) kept++;
  }
  log(`Seeded ${categories.length} categories with localName and imageUrl`);
  log(`Kept admin changes on ${kept} ${kept === 1 ? "category" : "categories"} (the fields, order and deletions an admin changed)`);
}
