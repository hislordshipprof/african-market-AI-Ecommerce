import { PrismaClient } from "@prisma/client";
import { parse } from "csv-parse/sync";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { uploadToR2 } from "../src/lib/r2";

interface CsvRow {
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

const CATEGORY_SLUG_TO_ID: Record<string, string> = {
  tubers: "cat_tubers",
  "grains-and-flours": "cat_grains",
  spices: "cat_spices",
  oils: "cat_oils",
  vegetables: "cat_vegetables",
  "fish-and-meat": "cat_fish_meat",
  frozen: "cat_frozen",
  snacks: "cat_snacks",
  drinks: "cat_drinks",
  beauty: "cat_beauty",
  "beans-and-legumes": "cat_beans_legumes",
  "breakfast-and-dairy": "cat_breakfast_dairy",
  "canned-and-packaged": "cat_canned_packaged",
  fruits: "cat_fruits",
  household: "cat_household",
  "seasonings-and-sauces": "cat_seasonings_sauces",
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function synonymId(productId: string, prefix: string, ...parts: (string | null | undefined)[]): string {
  const hash = createHash("sha256")
    .update(parts.filter(Boolean).join("|"))
    .digest("hex")
    .substring(0, 12);
  return `${productId}_${prefix}_${hash}`;
}

function parseLocalNames(raw: string): { term: string; language: string | null; region: string | null }[] {
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

function parseSearchSynonyms(raw: string): { term: string }[] {
  if (!raw) return [];
  return raw
    .split("|")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((term) => ({ term }));
}

async function downloadImage(
  url: string,
  productId: string,
): Promise<{ buffer: Buffer; contentType: string; ext: string } | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "AfricanMarketsPlatform/1.0 (catalog seed)",
      },
      redirect: "error",
    });
    if (!response.ok) return null;
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_BYTES) return null;
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) return null;
    const ext = contentType.includes("png") ? "png" : contentType.includes("svg") ? "svg" : "jpg";
    return { buffer, contentType, ext };
  } catch {
    console.warn(`Failed to download image for ${productId}: ${url}`);
    return null;
  }
}

export async function seedMasterCatalog(prisma: PrismaClient) {
  if (process.env.VERCEL_ENV === "production") {
    console.log("Skipping master catalog seed in production");
    return;
  }

  const csvPath = path.join(__dirname, "..", "research", "catalog", "master-catalog.csv");
  const csvContent = fs.readFileSync(csvPath, "utf-8");
  const rows: CsvRow[] = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  const hasR2 = !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  );

  const highRows = rows.filter((r) => r.confidence.trim() === "high");
  const reviewRows = rows.filter((r) => r.confidence.trim() !== "high");

  console.log(`Master catalog: ${highRows.length} high, ${reviewRows.length} review (${rows.length} total)`);

  let imageUploads = 0;
  let imageSkips = 0;
  let imageExisting = 0;

  for (const row of highRows) {
    const categoryId = CATEGORY_SLUG_TO_ID[row.category.trim()] ?? null;
    const weightG = row.typical_weight_g ? parseInt(row.typical_weight_g, 10) : null;
    const imageSourceUrl = row.image_url?.trim() || null;

    let imageUrl: string | null = null;

    if (hasR2 && imageSourceUrl) {
      const existing = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
        return tx.masterProduct.findUnique({ where: { id: row.id }, select: { imageUrl: true } });
      });
      if (existing?.imageUrl) {
        imageUrl = existing.imageUrl;
        imageExisting++;
      } else {
        const img = await downloadImage(imageSourceUrl, row.id);
        if (img) {
          try {
            const key = `catalog/${row.id}.${img.ext}`;
            imageUrl = await uploadToR2(key, img.buffer, img.contentType);
            imageUploads++;
          } catch (e) {
            console.warn(`R2 upload failed for ${row.id}:`, e);
          }
        } else {
          imageSkips++;
        }
        await new Promise((r) => setTimeout(r, 120));
      }
    }

    const productData = {
      name: row.english_name,
      categoryId,
      description: row.description || null,
      imageSourceUrl,
      imageAuthor: row.image_author || null,
      imageLicense: row.image_license || null,
      unit: row.unit || null,
      weightG: isNaN(weightG as number) ? null : weightG,
      frozen: row.storage?.trim().toLowerCase() === "frozen",
      perishable: row.perishable?.trim().toLowerCase() === "yes",
      storage: row.storage || null,
      subcategory: row.subcategory || null,
      originCountries: row.origin_countries || null,
      status: "active",
      confidence: "high",
    };

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.masterProduct.upsert({
        where: { id: row.id },
        update: {
          ...productData,
          ...(imageUrl !== null ? { imageUrl } : {}),
        },
        create: {
          id: row.id,
          ...productData,
          imageUrl,
        },
      });

      const localNames = parseLocalNames(row.local_names);
      for (const syn of localNames) {
        const synId = synonymId(row.id, "ln", syn.term, syn.language, syn.region);
        await tx.productSynonym.upsert({
          where: { id: synId },
          update: { term: syn.term, language: syn.language, region: syn.region },
          create: { id: synId, productId: row.id, term: syn.term, language: syn.language, region: syn.region },
        });
      }

      const searchSyns = parseSearchSynonyms(row.search_synonyms);
      for (const syn of searchSyns) {
        const synId = synonymId(row.id, "ss", syn.term);
        await tx.productSynonym.upsert({
          where: { id: synId },
          update: { term: syn.term },
          create: { id: synId, productId: row.id, term: syn.term },
        });
      }
    });
  }

  console.log(`Seeded ${highRows.length} high-confidence products (${imageUploads} images uploaded, ${imageExisting} existing, ${imageSkips} skipped)`);

  for (const row of reviewRows) {
    const categoryId = CATEGORY_SLUG_TO_ID[row.category.trim()] ?? null;
    const weightG = row.typical_weight_g ? parseInt(row.typical_weight_g, 10) : null;
    const imageSourceUrl = row.image_url?.trim() || null;

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.masterProduct.upsert({
        where: { id: row.id },
        update: {
          name: row.english_name,
          categoryId,
          description: row.description || null,
          imageSourceUrl,
          imageAuthor: row.image_author || null,
          imageLicense: row.image_license || null,
          unit: row.unit || null,
          weightG: isNaN(weightG as number) ? null : weightG,
          frozen: row.storage?.trim().toLowerCase() === "frozen",
          perishable: row.perishable?.trim().toLowerCase() === "yes",
          storage: row.storage || null,
          subcategory: row.subcategory || null,
          originCountries: row.origin_countries || null,
          confidence: row.confidence.trim(),
        },
        create: {
          id: row.id,
          name: row.english_name,
          categoryId,
          description: row.description || null,
          imageUrl: null,
          imageSourceUrl,
          imageAuthor: row.image_author || null,
          imageLicense: row.image_license || null,
          unit: row.unit || null,
          weightG: isNaN(weightG as number) ? null : weightG,
          frozen: row.storage?.trim().toLowerCase() === "frozen",
          perishable: row.perishable?.trim().toLowerCase() === "yes",
          storage: row.storage || null,
          subcategory: row.subcategory || null,
          originCountries: row.origin_countries || null,
          status: "needs_review",
          confidence: row.confidence.trim(),
        },
      });

      const localNames = parseLocalNames(row.local_names);
      for (const syn of localNames) {
        const synId = synonymId(row.id, "ln", syn.term, syn.language, syn.region);
        await tx.productSynonym.upsert({
          where: { id: synId },
          update: { term: syn.term, language: syn.language, region: syn.region },
          create: { id: synId, productId: row.id, term: syn.term, language: syn.language, region: syn.region },
        });
      }

      const searchSyns = parseSearchSynonyms(row.search_synonyms);
      for (const syn of searchSyns) {
        const synId = synonymId(row.id, "ss", syn.term);
        await tx.productSynonym.upsert({
          where: { id: synId },
          update: { term: syn.term },
          create: { id: synId, productId: row.id, term: syn.term },
        });
      }
    });
  }

  console.log(`Seeded ${reviewRows.length} review-queue products (status='needs_review')`);
}
