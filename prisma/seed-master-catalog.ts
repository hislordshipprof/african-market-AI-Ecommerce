import { PrismaClient } from "@prisma/client";
import { parse } from "csv-parse/sync";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { uploadToR2, catalogImageUrl } from "../src/lib/r2";

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
const MAX_RETRIES = 5;

function getS3Client() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

async function listR2Objects(prefix: string): Promise<string[]> {
  const client = getS3Client();
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET!,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const obj of resp.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    token = resp.NextContinuationToken;
  } while (token);
  return keys;
}

async function deleteR2Objects(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const client = getS3Client();
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: process.env.R2_BUCKET!,
        Delete: { Objects: batch.map((Key) => ({ Key })) },
      }),
    );
  }
}

function toThumbnailUrl(originalUrl: string, width: number): string {
  try {
    const url = new URL(originalUrl);
    if (!url.hostname.endsWith("wikimedia.org")) return originalUrl;
    const parts = url.pathname.split("/");
    const commonsIdx = parts.indexOf("commons");
    if (commonsIdx === -1) return originalUrl;
    if (parts[commonsIdx + 1] === "thumb") return originalUrl;
    const filename = parts[parts.length - 1];
    const thumbSuffix = filename.toLowerCase().endsWith(".svg")
      ? `${width}px-${filename}.png`
      : `${width}px-${filename}`;
    const newParts = [...parts];
    newParts.splice(commonsIdx + 1, 0, "thumb");
    newParts.push(thumbSuffix);
    return `${url.origin}${newParts.join("/")}`;
  } catch {
    return originalUrl;
  }
}

async function fetchWithRetry(
  url: string,
  productId: string,
): Promise<Buffer | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "AfricanMarketsPlatform/1.0 (catalog-seed)",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30000),
      });
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const baseMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : 1000 * Math.pow(2, attempt);
        const jitter = Math.random() * 1000;
        await new Promise((r) => setTimeout(r, Math.min(baseMs + jitter, 60000)));
        continue;
      }
      if (response.status === 404) return null;
      if (!response.ok) return null;
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;
      return buf;
    } catch {
      if (attempt < MAX_RETRIES - 1) {
        const baseMs = 1000 * Math.pow(2, attempt);
        const jitter = Math.random() * 1000;
        await new Promise((r) => setTimeout(r, baseMs + jitter));
        continue;
      }
      return null;
    }
  }
  return null;
}

async function downloadAndOptimize(
  url: string,
  productId: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const thumbUrl = toThumbnailUrl(url, 960);
  const urls = thumbUrl !== url ? [thumbUrl, url] : [url];
  for (const fetchUrl of urls) {
    const raw = await fetchWithRetry(fetchUrl, productId);
    if (raw) {
      try {
        const webpBuf = await sharp(raw)
          .resize(960, 960, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
        return { buffer: webpBuf, contentType: "image/webp" };
      } catch {
        console.warn(`sharp conversion failed for ${productId}`);
        continue;
      }
    }
  }
  return null;
}

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
  let totalUploadBytes = 0;
  const failures: { id: string; reason: string }[] = [];

  const existingR2Keys = hasR2 ? new Set(await listR2Objects("catalog/")) : new Set<string>();
  const oldKeysToDelete = [...existingR2Keys].filter((k) => !k.endsWith(".webp"));

  const withImages = highRows.filter((r) => r.image_url?.trim());
  let processed = 0;

  for (const row of highRows) {
    const categoryId = CATEGORY_SLUG_TO_ID[row.category.trim()] ?? null;
    const weightG = row.typical_weight_g ? parseInt(row.typical_weight_g, 10) : null;
    const imageSourceUrl = row.image_url?.trim() || null;

    let imageUrl: string | null = null;

    if (hasR2 && imageSourceUrl) {
      const webpKey = `catalog/${row.id}.webp`;
      if (existingR2Keys.has(webpKey)) {
        imageUrl = catalogImageUrl(webpKey);
        imageExisting++;
      } else {
        const img = await downloadAndOptimize(imageSourceUrl, row.id);
        if (img) {
          try {
            imageUrl = await uploadToR2(webpKey, img.buffer, img.contentType);
            imageUploads++;
            totalUploadBytes += img.buffer.byteLength;
          } catch (e) {
            console.warn(`R2 upload failed for ${row.id}:`, e);
            failures.push({ id: row.id, reason: "R2 upload failed" });
          }
        } else {
          imageSkips++;
          failures.push({ id: row.id, reason: "download/convert failed" });
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      processed++;
      if (processed % 10 === 0) {
        console.log(`  images: ${processed}/${withImages.length} (${imageUploads} new, ${imageExisting} cached, ${imageSkips} failed)`);
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

  if (hasR2 && oldKeysToDelete.length > 0) {
    await deleteR2Objects(oldKeysToDelete);
    console.log(`Deleted ${oldKeysToDelete.length} old non-webp R2 objects`);
  }

  const coveragePct = highRows.length > 0
    ? (((imageUploads + imageExisting) / highRows.filter((r) => r.image_url?.trim()).length) * 100).toFixed(1)
    : "N/A";
  console.log(
    `Seeded ${highRows.length} high-confidence products ` +
    `(${imageUploads} webp uploaded [${(totalUploadBytes / 1024 / 1024).toFixed(2)} MB], ` +
    `${imageExisting} existing, ${imageSkips} skipped, ` +
    `coverage: ${coveragePct}%)`,
  );
  if (failures.length > 0) {
    console.log(`Image failures (${failures.length}):`);
    for (const f of failures) {
      console.log(`  ${f.id}: ${f.reason}`);
    }
  }

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
