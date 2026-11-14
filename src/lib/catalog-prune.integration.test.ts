import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { Client } from "pg";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { catalogPruneMode } from "./catalog-prune";
import { createFakeR2 } from "./catalog-prune-fake-r2";
import { readCatalogImageReferences, withReferenceReadClient } from "./catalog-prune-reader";
import { resolveDirectUrl } from "./env";
import { storeScopedTransaction } from "./db";
import { seedMasterCatalog, uncoordinatedCatalogWriters } from "../../prisma/seed-master-catalog";

const catalogUploadGate = vi.hoisted(() => ({
  download: null as null | (() => Promise<{ ok: false; reason: "upload"; cause: unknown }>),
  list: null as null | (() => Promise<unknown[]>),
}));

vi.mock("./catalog-image", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./catalog-image")>();
  return {
    ...actual,
    downloadAndUploadImage: (
      sourceUrl: string,
      productId: string,
      options?: Parameters<typeof actual.downloadAndUploadImage>[2],
    ) =>
      catalogUploadGate.download
        ? catalogUploadGate.download()
        : actual.downloadAndUploadImage(sourceUrl, productId, options),
  };
});

vi.mock("./catalog-prune-execute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./catalog-prune-execute")>();
  return {
    ...actual,
    listCatalogObjects: (
      client: Parameters<typeof actual.listCatalogObjects>[0],
      bucket: string,
      prefix?: string,
    ) =>
      catalogUploadGate.list
        ? catalogUploadGate.list()
        : actual.listCatalogObjects(client, bucket, prefix),
  };
});

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t225${Date.now().toString(36)}`;
const BUCKET = "t225-fake-bucket";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-15T12:00:00.000Z");
const CSV_HEADER = "id,english_name,local_names,search_synonyms,category,subcategory,origin_countries,product_type,common_brands,unit,common_pack_sizes,typical_weight_g,storage,perishable,description,image_url,image_source_page,image_license,image_author,sources,confidence,notes";

const old = new Date(NOW.getTime() - 30 * DAY);
const fresh = new Date(NOW.getTime() - 60 * 60 * 1000);

function csv(rows: { id: string; confidence: string; imageUrl?: string }[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "t225-csv-"));
  const file = path.join(dir, "rows.csv");
  const lines = [CSV_HEADER];
  for (const row of rows) {
    const cols = Array.from({ length: 22 }, () => "");
    cols[0] = row.id;
    cols[1] = row.id;
    cols[15] = row.imageUrl ?? "";
    cols[20] = row.confidence;
    lines.push(cols.join(","));
  }
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

describe.skipIf(!hasDb)("catalog prune on the lane database", () => {
  let prisma: PrismaClient;
  let storeA = "";
  let storeB = "";
  const masterIds: string[] = [];
  const bannerIds: string[] = [];
  const collectionIds: string[] = [];
  const userIds: string[] = [];
  const categoryIds: string[] = [];
  const storeIds: string[] = [];
  const savedEnv = {
    bucket: process.env.R2_BUCKET,
    account: process.env.R2_ACCOUNT_ID,
    access: process.env.R2_ACCESS_KEY_ID,
    secret: process.env.R2_SECRET_ACCESS_KEY,
    prune: process.env.SEED_PRUNE_R2,
    ci: process.env.CI,
    vercel: process.env.VERCEL,
    vercelEnv: process.env.VERCEL_ENV,
    nodeEnv: process.env.NODE_ENV,
    e2e: process.env.E2E_STORE_OVERRIDE,
  };

  beforeAll(async () => {
    prisma = testPrismaClient(resolveDirectUrl());
    await prisma.$connect();
    const stores = await prisma.$queryRaw<Array<{ id: string; slug: string }>>`
      SELECT id, slug FROM stores WHERE slug IN ('mama-ngozi', 'tante-marie')
    `;
    storeA = stores.find((store) => store.slug === "mama-ngozi")?.id ?? "";
    storeB = stores.find((store) => store.slug === "tante-marie")?.id ?? "";
    if (!storeA || !storeB) throw new Error("lane seed is missing mama-ngozi or tante-marie");
  });

  afterAll(async () => {
    if (!prisma) return;
    await asAdmin(prisma, async (tx) => {
      if (bannerIds.length) await tx.storeBanner.deleteMany({ where: { id: { in: bannerIds } } });
      if (collectionIds.length) await tx.storeCollection.deleteMany({ where: { id: { in: collectionIds } } });
      if (masterIds.length) {
        await tx.productSynonym.deleteMany({ where: { productId: { in: masterIds } } });
        await tx.masterProduct.deleteMany({ where: { id: { in: masterIds } } });
      }
      if (categoryIds.length) await tx.category.deleteMany({ where: { id: { in: categoryIds } } });
    });
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (storeIds.length) await asAdmin(prisma, async (tx) => tx.store.deleteMany({ where: { id: { in: storeIds } } }));
    await prisma.$disconnect();
    restoreEnv();
  });

  function restoreEnv() {
    assign("R2_BUCKET", savedEnv.bucket);
    assign("R2_ACCOUNT_ID", savedEnv.account);
    assign("R2_ACCESS_KEY_ID", savedEnv.access);
    assign("R2_SECRET_ACCESS_KEY", savedEnv.secret);
    assign("SEED_PRUNE_R2", savedEnv.prune);
    assign("CI", savedEnv.ci);
    assign("VERCEL", savedEnv.vercel);
    assign("VERCEL_ENV", savedEnv.vercelEnv);
    assign("NODE_ENV", savedEnv.nodeEnv);
    assign("E2E_STORE_OVERRIDE", savedEnv.e2e);
  }

  function configureBucket() {
    process.env.R2_ACCOUNT_ID = "acct-t225";
    process.env.R2_ACCESS_KEY_ID = "sentinel-access-value";
    process.env.R2_SECRET_ACCESS_KEY = "sentinel-secret-value";
    process.env.R2_BUCKET = BUCKET;
  }

  it("a non-string R2 upload error does not abort later catalog rows", async () => {
    const cause = await repeatedMessageUploadError();
    expect(Array.isArray((cause as { message?: unknown }).message)).toBe(true);
    catalogUploadGate.download = async () => ({ ok: false, reason: "upload", cause });
    catalogUploadGate.list = async () => [];
    configureBucket();
    delete process.env.SEED_PRUNE_R2;
    const badId = `${RUN}-cause-bad`;
    const laterId = `${RUN}-cause-later`;
    masterIds.push(badId, laterId);
    const logs: string[] = [];
    try {
      await seedMasterCatalog(prisma, {
        csvPath: csv([
          { id: badId, confidence: "high", imageUrl: "https://images.example/bad.png" },
          { id: laterId, confidence: "high" },
        ]),
        now: () => NOW,
        log: (line) => logs.push(line),
      });
      expect(logs).toContain(`R2 upload failed for ${badId}: AccessDenied (HTTP 403)`);
      expect(logs.some((line) => line.startsWith("Image failures"))).toBe(true);
      const rows = await asAdmin(prisma, (tx) =>
        tx.masterProduct.findMany({
          where: { id: { in: [badId, laterId] } },
          select: { id: true, imageUrl: true },
        }),
      );
      expect(rows.map((row) => row.id).sort()).toEqual([badId, laterId].sort());
      expect(rows.find((row) => row.id === badId)?.imageUrl).toBeNull();
    } finally {
      catalogUploadGate.download = null;
      catalogUploadGate.list = null;
      restoreEnv();
    }
  });

  it("default seed with R2 configured lists only and never sends DeleteObjects", async () => {
    configureBucket();
    delete process.env.SEED_PRUNE_R2;
    const orphan = `catalog/${RUN}-off-orphan.jpg`;
    const fake = createFakeR2({
      bucket: BUCKET,
      objects: [
        { key: orphan, lastModified: old },
        { key: `catalog/${RUN}-off.webp`, lastModified: old },
      ],
    });
    const logs: string[] = [];
    const id = `${RUN}-off`;
    masterIds.push(id);
    await seedMasterCatalog(prisma, {
      r2: fake,
      csvPath: csv([{ id, confidence: "high" }]),
      now: () => NOW,
      log: (line) => logs.push(line),
    });
    expect(fake.recorded.some((command) => command.name === "ListObjectsV2")).toBe(true);
    expect(fake.recorded.some((command) => command.name === "DeleteObjects")).toBe(false);
    expect(fake.objects().some((object) => object.key === orphan)).toBe(true);
    expect(logs.join("\n")).toContain("Catalog prune skipped");
    restoreEnv();
  });

  it("dry-run prints every candidate and deletes nothing", async () => {
    const { fake, logs, orphan } = await seedAc2("dry-run");
    expect(fake.recorded.some((command) => command.name === "DeleteObjects")).toBe(false);
    expect(logs.some((line) => line === `candidate ${orphan}`)).toBe(true);
    expect(logs.some((line) => line.includes("0 deleted"))).toBe(true);
    expect(fake.objects().some((object) => object.key === orphan)).toBe(true);
  });

  it("bucket-name prune deletes only the old unreferenced non-webp key", async () => {
    const { fake, logs, orphan, kept } = await seedAc2("delete");
    const deletes = fake.recorded.filter((command) => command.name === "DeleteObjects");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.input.Delete?.Objects?.map((object) => object.Key)).toEqual([orphan]);
    expect(logs.some((line) => line === `deleted ${orphan}`)).toBe(true);
    for (const key of kept) expect(fake.objects().some((object) => object.key === key)).toBe(true);
    expect(fake.objects().some((object) => object.key === orphan)).toBe(false);
  });

  it("references from store A banner and store B collection both protect their keys", async () => {
    const { kept } = await seedAc2("delete");
    const banner = kept.find((key) => key.endsWith("-banner.jpg"));
    const collection = kept.find((key) => key.endsWith("-coll.png"));
    expect(banner && collection).toBeTruthy();
  });

  it("missing admin scope aborts while master products remain readable", async () => {
    const key = `catalog/${RUN}-hidden-banner.jpg`;
    const bannerId = `${RUN}-hidden-banner`;
    bannerIds.push(bannerId);
    await asAdmin(prisma, (tx) => tx.storeBanner.create({
      data: { id: bannerId, storeId: storeB, title: "Hidden", imageUrl: key, active: true },
    }));
    const visible = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM master_products LIMIT 1`;
    expect(visible.length).toBeGreaterThan(0);
    await expect(readCatalogImageReferences({ skipAdmin: true })).rejects.toThrow(/platform-admin read-only/);
    const read = await readCatalogImageReferences();
    expect(read.references.some((reference) => reference.includes(key))).toBe(true);
  });

  it("reader success and failure do not leak platform scope to store A", async () => {
    const bannerId = `${RUN}-leak-banner`;
    bannerIds.push(bannerId);
    await asAdmin(prisma, (tx) => tx.storeBanner.create({
      data: { id: bannerId, storeId: storeB, title: "Leak", imageUrl: `catalog/${RUN}-leak.jpg`, active: false },
    }));
    await readCatalogImageReferences();
    await expect(readCatalogImageReferences({ skipAdmin: true })).rejects.toThrow(/platform-admin/);
    const rows = await storeScopedTransaction(storeA, async (tx) =>
      tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM store_banners WHERE id = ${bannerId}`,
    );
    expect(rows).toEqual([]);
    const updated = await storeScopedTransaction(storeA, async (tx) =>
      tx.$executeRaw`UPDATE store_banners SET title = title WHERE id = ${bannerId}`,
    );
    expect(updated).toBe(0);
    const admin = await storeScopedTransaction(storeA, async (tx) =>
      tx.$queryRaw<Array<{ admin: string | null }>>`SELECT current_setting('app.is_platform_admin', true) AS admin`,
    );
    expect(admin[0]?.admin).not.toBe("true");
  });

  it("every image column independently protects an inactive or non-demo-store reference", async () => {
    const keys = {
      master: `catalog/${RUN}-col-master.jpg`,
      category: `catalog/${RUN}-col-category.jpg`,
      banner: `catalog/${RUN}-col-banner.jpg`,
      collection: `catalog/${RUN}-col-collection.jpg`,
      logo: `catalog/${RUN}-col-logo.jpg`,
      owner: `catalog/${RUN}-col-owner.jpg`,
      user: `catalog/${RUN}-col-user.jpg`,
    };
    const storeId = `${RUN}-store`;
    const categoryId = `${RUN}-category`;
    const masterId = `${RUN}-col-master`;
    const bannerId = `${RUN}-col-banner`;
    const collectionId = `${RUN}-col-collection`;
    const nullCollectionId = `${RUN}-col-null`;
    const userId = `${RUN}-user`;
    storeIds.push(storeId);
    categoryIds.push(categoryId);
    masterIds.push(masterId);
    bannerIds.push(bannerId);
    collectionIds.push(collectionId, nullCollectionId);
    userIds.push(userId);
    await asAdmin(prisma, async (tx) => {
      await tx.store.create({ data: { id: storeId, slug: storeId, name: storeId, logoUrl: keys.logo, ownerPhotoUrl: keys.owner } });
      await tx.category.create({ data: { id: categoryId, name: categoryId, slug: categoryId, imageUrl: keys.category, sortOrder: 99 } });
      await tx.masterProduct.create({ data: { id: masterId, name: masterId, imageUrl: keys.master, status: "rejected" } });
      await tx.storeBanner.create({ data: { id: bannerId, storeId, title: "Inactive", imageUrl: keys.banner, active: false } });
      await tx.storeCollection.create({ data: { id: collectionId, storeId, title: "Inactive", slug: collectionId, imageUrl: keys.collection, active: false } });
      await tx.storeCollection.create({ data: { id: nullCollectionId, storeId, title: "Null", slug: nullCollectionId, imageUrl: null, active: false } });
    });
    await prisma.user.create({ data: { id: userId, name: userId, email: `${userId}@example.com`, image: keys.user } });
    await prisma.user.create({ data: { id: `${userId}-null`, name: "null", email: `${userId}-null@example.com`, image: null } });
    userIds.push(`${userId}-null`);
    const read = await readCatalogImageReferences();
    for (const key of Object.values(keys)) {
      expect(read.references.some((reference) => reference.includes(key))).toBe(true);
    }
    expect(read.references).not.toContain("");
    expect(read.references.some((reference) => reference.includes(`catalog/${RUN}-null.jpg`))).toBe(false);
  });

  it("reference transfer between columns is seen in one snapshot", async () => {
    const key = `catalog/${RUN}-move.jpg`;
    const collectionId = `${RUN}-move`;
    collectionIds.push(collectionId);
    await asAdmin(prisma, (tx) => tx.storeCollection.create({
      data: { id: collectionId, storeId: storeA, title: "Move", slug: collectionId, imageUrl: key, active: false },
    }));
    const read = await readCatalogImageReferences({
      afterSnapshot: async () => {
        const client = new Client({ connectionString: resolveDirectUrl() });
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE app_user");
          await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
          await client.query("UPDATE store_collections SET image_url = $1 WHERE id = $2", ["https://example.com/replaced.jpg", collectionId]);
          await client.query("COMMIT");
        } finally {
          await client.end();
        }
      },
    });
    expect(read.references.some((reference) => reference.includes(key))).toBe(true);
  });

  it("reference query failure aborts before deleting", async () => {
    configureBucket();
    const orphan = `catalog/${RUN}-query-orphan.jpg`;
    const fake = createFakeR2({ bucket: BUCKET, objects: [{ key: orphan, lastModified: old }] });
    const id = `${RUN}-query`;
    masterIds.push(id);
    await expect(seedMasterCatalog(prisma, {
      execution: { kind: "harness", mode: "delete" },
      writerGate: { exclusive: () => true },
      r2: fake,
      csvPath: csv([{ id, confidence: "high" }]),
      now: () => NOW,
      log: () => undefined,
      afterReferenceSnapshot: async (client) => {
        await client.query("SET LOCAL search_path TO pg_catalog");
      },
    })).rejects.toThrow();
    expect(fake.recorded.some((command) => command.name === "DeleteObjects")).toBe(false);
    expect(fake.objects().some((object) => object.key === orphan)).toBe(true);
    restoreEnv();
  });

  it("review-row failure prevents prune and null-image upserts preserve references", async () => {
    configureBucket();
    const kept = `catalog/${RUN}-keep.jpg`;
    const orphan = `catalog/${RUN}-review-orphan.jpg`;
    const keepId = `${RUN}-keep`;
    const reviewId = `${RUN}-review-fail`;
    masterIds.push(keepId, reviewId);
    await asAdmin(prisma, (tx) => tx.masterProduct.create({
      data: { id: keepId, name: keepId, imageUrl: `/api/catalog-image/${kept}`, status: "needs_review" },
    }));
    const fake = createFakeR2({
      bucket: BUCKET,
      objects: [
        { key: kept, lastModified: old },
        { key: orphan, lastModified: old },
      ],
    });
    await seedMasterCatalog(prisma, {
      execution: { kind: "harness", mode: "delete" },
      writerGate: { exclusive: () => true },
      r2: fake,
      csvPath: csv([{ id: keepId, confidence: "low" }]),
      now: () => NOW,
      log: () => undefined,
    });
    const still = await asAdmin(prisma, (tx) => tx.masterProduct.findUnique({ where: { id: keepId } }));
    expect(still?.imageUrl).toBe(`/api/catalog-image/${kept}`);
    expect(fake.objects().some((object) => object.key === kept)).toBe(true);
    expect(fake.objects().some((object) => object.key === orphan)).toBe(false);

    const original = prisma.$transaction.bind(prisma);
    prisma.$transaction = (async (fn: unknown, ...rest: unknown[]) => {
      if (typeof fn !== "function") return original(fn as never, ...rest as never[]);
      return original(async (tx) => {
        const client = tx as unknown as PrismaClient;
        const upsert = client.masterProduct.upsert.bind(client.masterProduct);
        client.masterProduct.upsert = (async (args: { where: { id: string } }) => {
          if (args.where.id === reviewId) throw new Error("review upsert failed");
          return upsert(args as never);
        }) as unknown as typeof client.masterProduct.upsert;
        return (fn as (value: unknown) => Promise<unknown>)(tx);
      });
    }) as typeof prisma.$transaction;
    const second = createFakeR2({ bucket: BUCKET, objects: [{ key: orphan, lastModified: old }] });
    try {
      await expect(seedMasterCatalog(prisma, {
        execution: { kind: "harness", mode: "delete" },
        writerGate: { exclusive: () => true },
        r2: second,
        csvPath: csv([{ id: keepId, confidence: "high" }, { id: reviewId, confidence: "low" }]),
        now: () => NOW,
        log: () => undefined,
      })).rejects.toThrow(/review upsert failed/);
    } finally {
      prisma.$transaction = original;
    }
    expect(second.recorded.some((command) => command.name === "DeleteObjects")).toBe(false);
    restoreEnv();
  });

  it("duplicate CSV ids do not masquerade as missing reference rows", async () => {
    configureBucket();
    const id = `${RUN}-dup`;
    masterIds.push(id);
    const orphan = `catalog/${RUN}-dup-orphan.jpg`;
    const fake = createFakeR2({ bucket: BUCKET, objects: [{ key: orphan, lastModified: old }] });
    await expect(seedMasterCatalog(prisma, {
      execution: { kind: "harness", mode: "delete" },
      writerGate: { exclusive: () => true },
      r2: fake,
      csvPath: csv([{ id, confidence: "high" }, { id, confidence: "high" }]),
      now: () => NOW,
      log: () => undefined,
    })).resolves.toBeUndefined();
    expect(fake.objects().some((object) => object.key === orphan)).toBe(false);
    restoreEnv();
  });

  it("old orphan replacement and late reference cannot race deletion", async () => {
    configureBucket();
    const orphan = `catalog/${RUN}-race.jpg`;
    const fake = createFakeR2({ bucket: BUCKET, objects: [{ key: orphan, lastModified: old }] });
    const id = `${RUN}-race`;
    masterIds.push(id);
    await expect(seedMasterCatalog(prisma, {
      execution: { kind: "harness", mode: "delete" },
      writerGate: uncoordinatedCatalogWriters,
      r2: fake,
      csvPath: csv([{ id, confidence: "high" }]),
      now: () => NOW,
      log: () => undefined,
    })).rejects.toThrow(/catalog writers are not coordinated/);
    expect(fake.recorded.some((command) => command.name === "DeleteObjects")).toBe(false);
    expect(fake.objects().some((object) => object.key === orphan)).toBe(true);
    const decision = catalogPruneMode({
      env: {
        ...process.env,
        SEED_PRUNE_R2: BUCKET,
        R2_ACCOUNT_ID: "acct-t225",
        R2_ACCESS_KEY_ID: "sentinel-access-value",
        R2_SECRET_ACCESS_KEY: "sentinel-secret-value",
        R2_BUCKET: BUCKET,
      },
      databaseUrl: resolveDirectUrl(),
      observed: { host: "127.0.0.1", port: "5434", database: "lane_t225" },
      writersCoordinated: false,
    });
    expect("refused" in decision).toBe(true);
    restoreEnv();
  });

  it("prune aborts when the reader cannot see the upserted master products", async () => {
    await expect(readCatalogImageReferences({ skipAdmin: true })).rejects.toThrow(/platform-admin read-only/);
  });

  it("reader transaction rejects writes with 25006", async () => {
    await expect(withReferenceReadClient(async (client) => {
      await client.query(
        `INSERT INTO users (id, name, email, updated_at) VALUES ($1, $2, $3, NOW())`,
        [`${RUN}-write`, "Write", `${RUN}-write@example.com`],
      );
    })).rejects.toMatchObject({ code: "25006" });
  });

  it.each([
    ["CI", "true"],
    ["CI", "1"],
    ["VERCEL", "1"],
    ["NODE_ENV", "production"],
    ["E2E_STORE_OVERRIDE", "1"],
    ["SEED_PRUNE_R2", "1"],
  ])("refused prune makes no R2 call and writes no fixture row (%s)", async (key, value) => {
    configureBucket();
    process.env.SEED_PRUNE_R2 = BUCKET;
    if (key !== "SEED_PRUNE_R2") process.env[key] = value;
    else process.env.SEED_PRUNE_R2 = "1";
    const fake = createFakeR2({ bucket: BUCKET, objects: [{ key: `catalog/${RUN}-refuse.jpg`, lastModified: old }] });
    const id = `${RUN}-refuse-${key}`;
    await expect(seedMasterCatalog(prisma, {
      r2: fake,
      csvPath: csv([{ id, confidence: "high" }]),
      now: () => NOW,
      log: () => undefined,
    })).rejects.toThrow(/Refusing catalog prune/);
    expect(fake.recorded).toEqual([]);
    const row = await asAdmin(prisma, (tx) => tx.masterProduct.findUnique({ where: { id } }));
    expect(row).toBeNull();
    restoreEnv();
  });

  it("per-key DeleteObjects Errors fail the seed with the failed keys named", async () => {
    configureBucket();
    const denied = `catalog/${RUN}-denied.jpg`;
    const ok = `catalog/${RUN}-ok.jpg`;
    const fake = createFakeR2({
      bucket: BUCKET,
      objects: [
        { key: ok, lastModified: old },
        { key: denied, lastModified: old },
      ],
      errorKeys: new Set([denied]),
    });
    const logs: string[] = [];
    const id = `${RUN}-errors`;
    masterIds.push(id);
    await expect(seedMasterCatalog(prisma, {
      execution: { kind: "harness", mode: "delete" },
      writerGate: { exclusive: () => true },
      r2: fake,
      csvPath: csv([{ id, confidence: "high" }]),
      now: () => NOW,
      log: (line) => logs.push(line),
    })).rejects.toThrow(new RegExp(`${denied} \\(AccessDenied\\)`));
    expect(logs.join("\n")).toContain(denied);
    expect(logs.join("\n")).toContain("AccessDenied");
    restoreEnv();
  });

  it("a throwing second batch reports the first batch and fails", async () => {
    configureBucket();
    const keys = Array.from({ length: 1001 }, (_, index) => `catalog/${RUN}-batch-${index}.jpg`);
    const fake = createFakeR2({
      bucket: BUCKET,
      objects: keys.map((key) => ({ key, lastModified: old })),
      throwOnBatch: 2,
    });
    const logs: string[] = [];
    const id = `${RUN}-batch`;
    masterIds.push(id);
    await expect(seedMasterCatalog(prisma, {
      execution: { kind: "harness", mode: "delete" },
      writerGate: { exclusive: () => true },
      r2: fake,
      csvPath: csv([{ id, confidence: "high" }]),
      now: () => NOW,
      log: (line) => logs.push(line),
    })).rejects.toThrow(/outcome unknown/);
    expect(logs.filter((line) => line.startsWith("deleted "))).toHaveLength(1000);
    restoreEnv();
  });

  it("second concurrent prune of the same keys succeeds", async () => {
    configureBucket();
    const orphan = `catalog/${RUN}-twice.jpg`;
    const fake = createFakeR2({ bucket: BUCKET, objects: [{ key: orphan, lastModified: old }] });
    const first = `${RUN}-twice-a`;
    const second = `${RUN}-twice-b`;
    masterIds.push(first, second);
    await Promise.all([
      seedMasterCatalog(prisma, {
        execution: { kind: "harness", mode: "delete" },
        writerGate: { exclusive: () => true },
        r2: fake,
        csvPath: csv([{ id: first, confidence: "high" }]),
        now: () => NOW,
        log: () => undefined,
      }),
      seedMasterCatalog(prisma, {
        execution: { kind: "harness", mode: "delete" },
        writerGate: { exclusive: () => true },
        r2: fake,
        csvPath: csv([{ id: second, confidence: "high" }]),
        now: () => NOW,
        log: () => undefined,
      }),
    ]);
    expect(fake.objects().some((object) => object.key === orphan)).toBe(false);
    expect(fake.objects().every((object) => object.key === orphan || object.key.startsWith(`catalog/${RUN}-twice`))).toBe(true);
    restoreEnv();
  });

  it("partial R2 keys and no opt-in: no R2 call, seed completes", async () => {
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.SEED_PRUNE_R2;
    process.env.R2_ACCOUNT_ID = "acct-t225";
    process.env.R2_BUCKET = BUCKET;
    const id = `${RUN}-partial`;
    masterIds.push(id);
    await expect(seedMasterCatalog(prisma, {
      csvPath: csv([{ id, confidence: "high" }]),
      log: () => undefined,
    })).resolves.toBeUndefined();
    const row = await asAdmin(prisma, (tx) => tx.masterProduct.findUnique({ where: { id } }));
    expect(row?.id).toBe(id);
    restoreEnv();
  });

  it("positive fake-R2 scenarios run on a real lane under hosted CI env", async () => {
    configureBucket();
    process.env.SEED_PRUNE_R2 = BUCKET;
    process.env.CI = "true";
    process.env.E2E_STORE_OVERRIDE = "1";
    assign("NODE_ENV", "test");
    const decision = catalogPruneMode({
      env: process.env,
      databaseUrl: resolveDirectUrl(),
      observed: { host: "127.0.0.1", port: "5434", database: "lane_t225" },
    });
    expect(decision).toEqual({ refused: expect.stringContaining("CI is set") });
    const orphan = `catalog/${RUN}-ci-orphan.jpg`;
    const fake = createFakeR2({ bucket: BUCKET, objects: [{ key: orphan, lastModified: old }] });
    const id = `${RUN}-ci`;
    masterIds.push(id);
    await seedMasterCatalog(prisma, {
      execution: { kind: "harness", mode: "delete" },
      writerGate: { exclusive: () => true },
      r2: fake,
      csvPath: csv([{ id, confidence: "high" }]),
      now: () => NOW,
      log: () => undefined,
    });
    expect(fake.objects().some((object) => object.key === orphan)).toBe(false);
    restoreEnv();
  });

  it("the age cutoff is the clock at entry, before listing", async () => {
    configureBucket();
    const entry = Date.parse("2026-06-15T12:00:00.000Z");
    let nowMs = entry;
    const key = `catalog/${RUN}-young.jpg`;
    const fake = createFakeR2({
      bucket: BUCKET,
      objects: [{ key, lastModified: new Date(entry - 24 * 60 * 60 * 1000 + 1000) }],
    });
    const send = fake.send.bind(fake);
    fake.send = async (command: unknown) => {
      const result = await send(command);
      nowMs += 2000;
      return result;
    };
    const logs: string[] = [];
    await seedMasterCatalog(prisma, {
      execution: { kind: "harness", mode: "dry-run" },
      r2: fake,
      csvPath: csv([]),
      now: () => new Date(nowMs),
      log: (line) => logs.push(line),
    });
    expect(logs.some((line) => line.includes(key))).toBe(false);
    expect(fake.objects().some((object) => object.key === key)).toBe(true);
    restoreEnv();
  });

  it("a successful upload followed by a failed upsert does not prune", async () => {
    configureBucket();
    const id = `${RUN}-upload-fail`;
    masterIds.push(id);
    const uploaded: string[] = [];
    const fake = createFakeR2({ bucket: BUCKET, objects: [] });
    const dir = csv([{ id, confidence: "high" }]);
    const header = "id,english_name,local_names,search_synonyms,category,subcategory,origin_countries,product_type,common_brands,unit,common_pack_sizes,typical_weight_g,storage,perishable,description,image_url,image_source_page,image_license,image_author,sources,confidence,notes";
    const cols = Array.from({ length: 22 }, () => "");
    cols[0] = id;
    cols[1] = id;
    cols[15] = "https://example.test/a.jpg";
    cols[20] = "high";
    writeFileSync(dir, `${header}\n${cols.join(",")}\n`);
    const original = prisma.$transaction.bind(prisma);
    prisma.$transaction = (async () => {
      throw new Error("upsert failed after upload");
    }) as unknown as typeof prisma.$transaction;
    try {
      await expect(seedMasterCatalog(prisma, {
        execution: { kind: "harness", mode: "delete" },
        writerGate: { exclusive: () => true },
        r2: fake,
        csvPath: dir,
        uploadImage: async (_source, productId) => {
          const key = `catalog/${productId}.webp`;
          uploaded.push(key);
          return { ok: true, url: `/api/catalog-image/${key}`, bytes: 4 };
        },
        now: () => NOW,
        log: () => undefined,
      })).rejects.toThrow(/upsert failed after upload/);
    } finally {
      prisma.$transaction = original;
    }
    expect(uploaded).toEqual([`catalog/${id}.webp`]);
    expect(fake.recorded.some((command) => command.name === "DeleteObjects")).toBe(false);
    const row = await asAdmin(prisma, (tx) => tx.masterProduct.findUnique({ where: { id } }));
    expect(row).toBeNull();
    restoreEnv();
  });

  async function seedAc2(mode: "dry-run" | "delete") {
    configureBucket();
    const stamp = `${RUN}-${mode}-${Math.random().toString(36).slice(2, 8)}`;
    const orphan = `catalog/${stamp}-orphan.jpg`;
    const freshKey = `catalog/${stamp}-fresh.png`;
    const ref = `catalog/${stamp}-ref.jpg`;
    const bannerKey = `catalog/${stamp}-banner.jpg`;
    const collectionKey = `catalog/${stamp}-coll.png`;
    const userKey = `catalog/${stamp}-user.jpg`;
    const webp = `catalog/${stamp}-a.webp`;
    const masterId = `${stamp}-ref`;
    const seededId = `${stamp}-seeded`;
    const bannerId = `${stamp}-banner`;
    const collectionId = `${stamp}-collection`;
    const userId = `${stamp}-user`;
    masterIds.push(masterId, seededId);
    bannerIds.push(bannerId);
    collectionIds.push(collectionId);
    userIds.push(userId);
    await asAdmin(prisma, async (tx) => {
      await tx.masterProduct.create({
        data: { id: masterId, name: masterId, imageUrl: `/api/catalog-image/${ref}`, status: "active" },
      });
      await tx.storeBanner.create({
        data: { id: bannerId, storeId: storeA, title: "Banner", imageUrl: bannerKey, active: true },
      });
      await tx.storeCollection.create({
        data: {
          id: collectionId,
          storeId: storeB,
          title: "Collection",
          slug: collectionId,
          imageUrl: `https://cdn.example/sub/${collectionKey}?v=2`,
          active: true,
        },
      });
    });
    await prisma.user.create({ data: { id: userId, name: userId, email: `${userId}@example.com`, image: userKey } });
    const fake = createFakeR2({
      bucket: BUCKET,
      objects: [
        { key: orphan, lastModified: old },
        { key: freshKey, lastModified: fresh },
        { key: ref, lastModified: old },
        { key: bannerKey, lastModified: old },
        { key: collectionKey, lastModified: old },
        { key: userKey, lastModified: old },
        { key: webp, lastModified: old },
      ],
    });
    const logs: string[] = [];
    await seedMasterCatalog(prisma, {
      execution: { kind: "harness", mode },
      writerGate: { exclusive: () => true },
      r2: fake,
      csvPath: csv([{ id: seededId, confidence: "high" }]),
      now: () => NOW,
      log: (line) => logs.push(line),
    });
    return {
      fake,
      logs,
      orphan,
      kept: [freshKey, ref, bannerKey, collectionKey, userKey, webp],
    };
  }
});

async function asAdmin<T>(prisma: PrismaClient, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx as unknown as PrismaClient);
  });
}

function assign(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Real S3 client error for a 403 body with two Message tags. SDK 3.1161 leaves message as an array. */
async function repeatedMessageUploadError(): Promise<unknown> {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>AccessDenied</Code><Message>one</Message><Message>two</Message></Error>`;
  const server = createServer((_req, res) => {
    res.writeHead(403, { "content-type": "application/xml" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("upload-cause repro server has no port");
  }
  const client = new S3Client({
    region: "auto",
    endpoint: `http://127.0.0.1:${address.port}`,
    forcePathStyle: true,
    credentials: { accessKeyId: "repro", secretAccessKey: "repro-secret" },
  });
  try {
    await client.send(new PutObjectCommand({
      Bucket: "bucket",
      Key: "catalog/a.webp",
      Body: Buffer.from("x"),
    }));
    throw new Error("expected the repeated Message body to fail the upload");
  } catch (error) {
    if (error instanceof Error && error.message === "expected the repeated Message body to fail the upload") throw error;
    return error;
  } finally {
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
