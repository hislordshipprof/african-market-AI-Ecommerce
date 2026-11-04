import { PrismaClient } from "@prisma/client";
import type { Client } from "pg";
import { lookup } from "node:dns/promises";
import { parse } from "csv-parse/sync";
import * as fs from "fs";
import * as path from "path";
import { S3Client } from "@aws-sdk/client-s3";
import { catalogImageUrl } from "../src/lib/r2";
import { downloadAndUploadImage } from "../src/lib/catalog-image";
import { upsertMasterProduct, type CsvRow } from "./master-catalog-upsert";
import {
  catalogPruneMode,
  CatalogPruneRefusal,
  databaseIdentityFromUrl,
  planCatalogPrune,
  type PruneDecision,
} from "../src/lib/catalog-prune";
import { CATALOG_PRUNE_OWNERSHIP } from "../src/lib/catalog-prune-ownership";
import { deleteCatalogCandidates, listCatalogObjects } from "../src/lib/catalog-prune-execute";
import type { R2SendClient } from "../src/lib/catalog-prune-fake-r2";
import {
  assertUpsertsVisible,
  readCatalogImageReferences,
} from "../src/lib/catalog-prune-reader";
import { resolveDirectUrl } from "../src/lib/env";
import type { DatabaseIdentity } from "../src/lib/catalog-prune";

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

export type CatalogPruneExecution =
  | { kind: "cli" }
  | { kind: "harness"; mode: "off" | "dry-run" | "delete" };

export type WriterGate = { exclusive(): boolean };

/** Production gate. approveProduct and external restores do not join it. */
export const uncoordinatedCatalogWriters: WriterGate = { exclusive: () => false };

export type SeedMasterCatalogDeps = {
  r2?: R2SendClient;
  csvPath?: string;
  now?: () => Date;
  log?: (line: string) => void;
  /**
   * Test-only. The CLI never sets `harness`, and no environment variable can.
   * Harness mode skips the environment guard so a lane database can exercise
   * the real reader and a fake R2 client. It does not weaken the CLI guard.
   */
  execution?: CatalogPruneExecution;
  priorReferences?: string[];
  writerGate?: WriterGate;
  afterReferenceSnapshot?: (client: Client) => Promise<void>;
  /**
   * Test seam for a successful object write that then fails to commit.
   * The CLI does not set it. When set, it runs instead of the network uploader.
   */
  uploadImage?: (
    sourceUrl: string,
    productId: string,
  ) => Promise<{ ok: true; url: string; bytes: number } | { ok: false; reason: string }>;
};

function hasAllR2Keys(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET,
  );
}

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

async function resolveDatabaseHost(host: string): Promise<readonly string[]> {
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    return records.map((record) => record.address);
  } catch {
    return [];
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export async function decideCliCatalogPrune(
  env: NodeJS.ProcessEnv = process.env,
  observe?: () => Promise<DatabaseIdentity>,
  lookupHost: (host: string) => Promise<readonly string[]> = resolveDatabaseHost,
): Promise<PruneDecision> {
  const raw = env.SEED_PRUNE_R2;
  if (raw === undefined || raw.trim() === "") return { mode: "off" };
  let databaseUrl: string | null = null;
  try {
    databaseUrl = resolveDirectUrl();
  } catch {
    databaseUrl = null;
  }
  const preliminary = catalogPruneMode({
    env,
    databaseUrl,
    ownership: CATALOG_PRUNE_OWNERSHIP,
    writersCoordinated: false,
  });
  if ("refused" in preliminary && !preliminary.refused.includes("was not observed")) return preliminary;
  if (!observe) {
    return { refused: "Refusing catalog prune: the effective database connection was not observed" };
  }
  try {
    const observed = await observe();
    const resolvedHosts: Record<string, readonly string[]> = {};
    const fromUrl = databaseUrl ? databaseIdentityFromUrl(databaseUrl) : null;
    if (fromUrl && !isLoopbackHost(fromUrl.host)) {
      resolvedHosts[fromUrl.host] = await lookupHost(fromUrl.host);
    }
    return catalogPruneMode({
      env,
      databaseUrl,
      observed,
      ownership: CATALOG_PRUNE_OWNERSHIP,
      writersCoordinated: false,
      resolvedHosts,
    });
  } catch (error) {
    if (error instanceof CatalogPruneRefusal) return { refused: error.message };
    return { refused: "Refusing catalog prune: the effective database connection was not observed" };
  }
}

async function observePrisma(prisma: PrismaClient): Promise<DatabaseIdentity> {
  const rows = await prisma.$queryRaw<Array<{ database: string; host: string; port: string }>>`
    SELECT current_database() AS database,
           COALESCE(inet_server_addr()::text, '127.0.0.1') AS host,
           inet_server_port()::text AS port
  `;
  const row = rows[0];
  if (!row?.database || !row.host || !row.port) {
    throw new CatalogPruneRefusal(
      "Refusing catalog prune: the effective database connection was not observed",
    );
  }
  return { host: row.host, port: String(row.port), database: row.database };
}

export async function seedMasterCatalog(prisma: PrismaClient, deps: SeedMasterCatalogDeps = {}) {
  const startedAt = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? ((line: string) => console.log(line));
  const execution = deps.execution ?? { kind: "cli" as const };

  let mode: "off" | "dry-run" | "delete";
  if (execution.kind === "harness") {
    mode = execution.mode;
  } else {
    const decision = await decideCliCatalogPrune(process.env, () => observePrisma(prisma));
    if ("refused" in decision) throw new CatalogPruneRefusal(decision.refused);
    if (decision.mode === "off" && process.env.VERCEL_ENV === "production") {
      log("Skipping master catalog seed in production");
      return;
    }
    mode = decision.mode;
  }

  if (mode === "off") {
    log(
      "Catalog prune skipped (SEED_PRUNE_R2 is unset). Request a dry-run with SEED_PRUNE_R2=dry-run, or a delete with SEED_PRUNE_R2 set to the R2_BUCKET value.",
    );
  }

  const csvPath = deps.csvPath ?? path.join(__dirname, "..", "research", "catalog", "master-catalog.csv");
  const csvContent = fs.readFileSync(csvPath, "utf-8");
  const rows: CsvRow[] = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  const useRealR2 = execution.kind !== "harness" && !deps.r2 && hasAllR2Keys(process.env);
  const listClient: R2SendClient | null = deps.r2 ?? (useRealR2 ? getS3Client() : null);
  const bucket = process.env.R2_BUCKET;

  const highRows = rows.filter((row) => row.confidence.trim() === "high");
  const reviewRows = rows.filter((row) => row.confidence.trim() !== "high");
  log(`Master catalog: ${highRows.length} high, ${reviewRows.length} review (${rows.length} total)`);

  let imageUploads = 0;
  let imageSkips = 0;
  let imageExisting = 0;
  let totalUploadBytes = 0;
  const failures: { id: string; reason: string }[] = [];
  const upsertedIds: string[] = [];

  const existingR2Keys =
    listClient && bucket
      ? new Set((await listCatalogObjects(listClient, bucket)).map((object) => object.key))
      : new Set<string>();

  const withImages = highRows.filter((row) => row.image_url?.trim());
  let processed = 0;

  for (const row of highRows) {
    const categoryId = CATEGORY_SLUG_TO_ID[row.category.trim()] ?? null;
    const imageSourceUrl = row.image_url?.trim() || null;
    let imageUrl: string | null = null;

    if (imageSourceUrl && (deps.uploadImage || useRealR2)) {
      if (deps.uploadImage) {
        const img = await deps.uploadImage(imageSourceUrl, row.id);
        if (img.ok) {
          imageUrl = img.url;
          imageUploads++;
          totalUploadBytes += img.bytes;
        } else {
          imageSkips++;
          failures.push({ id: row.id, reason: img.reason });
        }
      } else if (useRealR2) {
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
          log(`R2 upload failed for ${row.id}`);
          failures.push({ id: row.id, reason: "R2 upload failed" });
        } else {
          imageSkips++;
          failures.push({ id: row.id, reason: "download/convert failed" });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      processed++;
      if (processed % 10 === 0) {
        log(`  images: ${processed}/${withImages.length} (${imageUploads} new, ${imageExisting} cached, ${imageSkips} failed)`);
      }
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await upsertMasterProduct(tx, row, categoryId, {
        statusOnCreate: "active",
        statusOnUpdate: "active",
        confidence: "high",
        imageUrl,
      });
    });
    upsertedIds.push(row.id);
  }

  for (const row of reviewRows) {
    const categoryId = CATEGORY_SLUG_TO_ID[row.category.trim()] ?? null;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await upsertMasterProduct(tx, row, categoryId, {
        statusOnCreate: "needs_review",
        confidence: row.confidence.trim(),
        imageUrl: null,
      });
    });
    upsertedIds.push(row.id);
  }

  const imageRowCount = highRows.filter((row) => row.image_url?.trim()).length;
  const coveragePct = imageRowCount > 0
    ? (((imageUploads + imageExisting) / imageRowCount) * 100).toFixed(1)
    : "N/A";
  log(
    `Seeded ${highRows.length} high-confidence products ` +
    `(${imageUploads} webp uploaded [${(totalUploadBytes / 1024 / 1024).toFixed(2)} MB], ` +
    `${imageExisting} existing, ${imageSkips} skipped, ` +
    `coverage: ${coveragePct}%)`,
  );
  if (failures.length > 0) {
    log(`Image failures (${failures.length}):`);
    for (const failure of failures) log(`  ${failure.id}: ${failure.reason}`);
  }
  log(`Seeded ${reviewRows.length} review-queue products (status='needs_review')`);

  if (mode === "off") return;

  if (!listClient || !bucket) {
    throw new CatalogPruneRefusal("Refusing catalog prune: missing R2_BUCKET");
  }

  const objects = await listCatalogObjects(listClient, bucket);
  const read = await readCatalogImageReferences({ afterSnapshot: deps.afterReferenceSnapshot });
  assertUpsertsVisible(read.masterProductIds, upsertedIds);
  const references = [...read.references, ...(deps.priorReferences ?? [])];
  const candidates = planCatalogPrune({ objects, references, now: startedAt });

  if (mode === "dry-run") {
    for (const key of candidates) log(`candidate ${key}`);
    log(`catalog prune dry-run: ${candidates.length} candidates, 0 deleted`);
    return;
  }

  const gate = deps.writerGate ?? uncoordinatedCatalogWriters;
  if (!gate.exclusive()) {
    throw new CatalogPruneRefusal(
      "Refusing catalog prune: catalog writers are not coordinated for the scan-to-delete interval",
    );
  }
  await deleteCatalogCandidates({ client: listClient, bucket, keys: candidates, log });
}
