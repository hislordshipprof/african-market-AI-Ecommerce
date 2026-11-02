import { PrismaClient } from "@prisma/client";
import { parse } from "csv-parse/sync";
import * as fs from "fs";
import * as path from "path";
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { catalogImageUrl } from "../src/lib/r2";
import { downloadAndUploadImage } from "../src/lib/catalog-image";
import { upsertMasterProduct, type CsvRow } from "./master-catalog-upsert";

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
    const imageSourceUrl = row.image_url?.trim() || null;

    let imageUrl: string | null = null;

    if (hasR2 && imageSourceUrl) {
      const webpKey = `catalog/${row.id}.webp`;
      if (existingR2Keys.has(webpKey)) {
        imageUrl = catalogImageUrl(webpKey);
        imageExisting++;
      } else {
        const img = await downloadAndUploadImage(imageSourceUrl, row.id, {
          sharp: true,
          retries: MAX_RETRIES,
          rewriteWikimedia: true,
          format: "webp",
          followRedirects: true,
          timeoutMs: 30000,
          userAgent: "AfricanMarketsPlatform/1.0 (catalog-seed)",
        });
        if (img.ok) {
          imageUrl = img.url;
          imageUploads++;
          totalUploadBytes += img.bytes;
        } else if (img.reason === "upload") {
          console.warn(`R2 upload failed for ${row.id}`);
          failures.push({ id: row.id, reason: "R2 upload failed" });
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

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await upsertMasterProduct(tx, row, categoryId, {
        status: "active",
        overwriteStatus: true,
        confidence: "high",
        imageUrl,
      });
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

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await upsertMasterProduct(tx, row, categoryId, {
        status: "needs_review",
        overwriteStatus: false,
        confidence: row.confidence.trim(),
        imageUrl: null,
      });
    });
  }

  console.log(`Seeded ${reviewRows.length} review-queue products (status='needs_review')`);
}
