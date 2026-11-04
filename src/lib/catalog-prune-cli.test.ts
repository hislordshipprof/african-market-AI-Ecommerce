import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "./env";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("catalog prune CLI", () => {
  const saved = {
    prune: process.env.SEED_PRUNE_R2,
    ci: process.env.CI,
    vercel: process.env.VERCEL,
    vercelEnv: process.env.VERCEL_ENV,
    nodeEnv: process.env.NODE_ENV,
    e2e: process.env.E2E_STORE_OVERRIDE,
    bucket: process.env.R2_BUCKET,
    account: process.env.R2_ACCOUNT_ID,
    access: process.env.R2_ACCESS_KEY_ID,
    secret: process.env.R2_SECRET_ACCESS_KEY,
    unpooled: process.env.DATABASE_URL_UNPOOLED,
    direct: process.env.DIRECT_URL,
  };

  afterAll(() => {
    assign("SEED_PRUNE_R2", saved.prune);
    assign("CI", saved.ci);
    assign("VERCEL", saved.vercel);
    assign("VERCEL_ENV", saved.vercelEnv);
    assign("NODE_ENV", saved.nodeEnv);
    assign("E2E_STORE_OVERRIDE", saved.e2e);
    assign("R2_BUCKET", saved.bucket);
    assign("R2_ACCOUNT_ID", saved.account);
    assign("R2_ACCESS_KEY_ID", saved.access);
    assign("R2_SECRET_ACCESS_KEY", saved.secret);
    assign("DATABASE_URL_UNPOOLED", saved.unpooled);
    assign("DIRECT_URL", saved.direct);
  });

  it("full seed refuses before any mutation in every forbidden context", async () => {
    const { runSeed } = await import("../../prisma/seed");
    const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
    const before = await prisma.$queryRaw<Array<{ updated_at: Date }>>`
      SELECT updated_at FROM stores WHERE slug = 'mama-ngozi'
    `;
    const contexts: Array<() => void> = [
      () => { process.env.SEED_PRUNE_R2 = "dry-run"; process.env.CI = "true"; },
      () => { process.env.SEED_PRUNE_R2 = "dry-run"; process.env.CI = "1"; },
      () => { process.env.SEED_PRUNE_R2 = "dry-run"; process.env.VERCEL = "1"; },
      () => { process.env.SEED_PRUNE_R2 = "lane-bucket"; assign("NODE_ENV", "production"); setR2("lane-bucket"); },
      () => { process.env.SEED_PRUNE_R2 = "dry-run"; process.env.VERCEL_ENV = "production"; },
      () => { process.env.SEED_PRUNE_R2 = "dry-run"; process.env.VERCEL_ENV = "preview"; },
      () => { process.env.SEED_PRUNE_R2 = "dry-run"; process.env.E2E_STORE_OVERRIDE = "1"; },
      () => { process.env.SEED_PRUNE_R2 = "1"; setR2("lane-bucket"); },
      () => { process.env.SEED_PRUNE_R2 = "dry-run"; delete process.env.R2_SECRET_ACCESS_KEY; setR2("lane-bucket"); delete process.env.R2_SECRET_ACCESS_KEY; },
      () => { process.env.SEED_PRUNE_R2 = "dry-run"; process.env.DATABASE_URL_UNPOOLED = "not a url"; },
    ];
    try {
      for (const apply of contexts) {
        restore();
        setR2("lane-bucket");
        apply();
        await expect(runSeed()).rejects.toThrow(/Refusing catalog prune/);
        const after = await prisma.$queryRaw<Array<{ updated_at: Date }>>`
          SELECT updated_at FROM stores WHERE slug = 'mama-ngozi'
        `;
        expect(new Date(after[0]!.updated_at).getTime()).toBe(new Date(before[0]!.updated_at).getTime());
        expect(`${after[0]!.updated_at}`).not.toContain("sentinel-secret-value");
      }
    } finally {
      restore();
      await prisma.$disconnect();
    }
  }, 60_000);

  it("off-mode hosted CI and preview keep their supported seed behaviour", async () => {
    const { seedMasterCatalog } = await import("../../prisma/seed-master-catalog");
    const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
    const previewId = `t225-preview-${Date.now().toString(36)}`;
    const productionId = `t225-prod-${Date.now().toString(36)}`;
    restore();
    delete process.env.SEED_PRUNE_R2;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    process.env.CI = "true";
    process.env.SEED_TEST_ADMIN = process.env.SEED_TEST_ADMIN;
    process.env.VERCEL_ENV = "preview";
    const logs: string[] = [];
    try {
      await seedMasterCatalog(prisma, {
        csvPath: csv(previewId, "high"),
        log: (line) => logs.push(line),
      });
      const preview = await asAdmin(prisma, (tx) => tx.masterProduct.findUnique({ where: { id: previewId } }));
      expect(preview?.id).toBe(previewId);
      process.env.VERCEL_ENV = "production";
      delete process.env.SEED_PRUNE_R2;
      const skipped: string[] = [];
      await seedMasterCatalog(prisma, {
        csvPath: csv(productionId, "high"),
        log: (line) => skipped.push(line),
      });
      const production = await asAdmin(prisma, (tx) => tx.masterProduct.findUnique({ where: { id: productionId } }));
      expect(production).toBeNull();
      expect(skipped.join("\n")).toContain("Skipping master catalog seed in production");
      process.env.VERCEL_ENV = "production";
      process.env.SEED_PRUNE_R2 = "dry-run";
      setR2("lane-bucket");
      await expect(seedMasterCatalog(prisma, {
        csvPath: csv(`${productionId}-opt`, "high"),
        log: () => undefined,
      })).rejects.toThrow(/VERCEL_ENV is production|CI is set|database host/);
    } finally {
      await asAdmin(prisma, (tx) => tx.masterProduct.deleteMany({ where: { id: { in: [previewId] } } }));
      await prisma.$disconnect();
      restore();
    }
  }, 60_000);

  it("pre-seed references survive demo reseeding with prune requested", async () => {
    const { runSeed } = await import("../../prisma/seed");
    const { createFakeR2 } = await import("./catalog-prune-fake-r2");
    const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
    const key = `catalog/t225-preseed-${Date.now().toString(36)}.jpg`;
    const orphan = `catalog/t225-preseed-orphan-${Date.now().toString(36)}.jpg`;
    const now = new Date("2026-06-15T12:00:00.000Z");
    const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    await asAdmin(prisma, (tx) => tx.store.update({
      where: { slug: "mama-ngozi" },
      data: { ownerPhotoUrl: key },
    }));
    const fake = createFakeR2({
      bucket: "t225-fake-bucket",
      objects: [
        { key, lastModified: old },
        { key: orphan, lastModified: old },
      ],
    });
    process.env.R2_BUCKET = "t225-fake-bucket";
    process.env.R2_ACCOUNT_ID = "acct-t225";
    process.env.R2_ACCESS_KEY_ID = "sentinel-access-value";
    process.env.R2_SECRET_ACCESS_KEY = "sentinel-secret-value";
    const seededId = `t225-preseed-row-${Date.now().toString(36)}`;
    try {
      await runSeed({
        execution: { kind: "harness", mode: "delete" },
        writerGate: { exclusive: () => true },
        r2: fake,
        csvPath: csv(seededId, "high"),
        now: () => now,
        log: () => undefined,
      });
      expect(fake.objects().some((object) => object.key === key)).toBe(true);
      expect(fake.objects().some((object) => object.key === orphan)).toBe(false);
      const store = await prisma.store.findUnique({ where: { slug: "mama-ngozi" } });
      expect(store?.ownerPhotoUrl).toBeNull();
    } finally {
      await asAdmin(prisma, async (tx) => {
        await tx.productSynonym.deleteMany({ where: { productId: seededId } });
        await tx.masterProduct.deleteMany({ where: { id: seededId } });
        await tx.store.update({ where: { slug: "mama-ngozi" }, data: { ownerPhotoUrl: null } });
      });
      await prisma.$disconnect();
      restore();
    }
  }, 120_000);

  function restore() {
    assign("SEED_PRUNE_R2", saved.prune);
    assign("CI", saved.ci);
    assign("VERCEL", saved.vercel);
    assign("VERCEL_ENV", saved.vercelEnv);
    assign("NODE_ENV", saved.nodeEnv);
    assign("E2E_STORE_OVERRIDE", saved.e2e);
    assign("R2_BUCKET", saved.bucket);
    assign("R2_ACCOUNT_ID", saved.account);
    assign("R2_ACCESS_KEY_ID", saved.access);
    assign("R2_SECRET_ACCESS_KEY", saved.secret);
    assign("DATABASE_URL_UNPOOLED", saved.unpooled);
    assign("DIRECT_URL", saved.direct);
  }

  function setR2(bucket: string) {
    process.env.R2_ACCOUNT_ID = "acct-t225";
    process.env.R2_ACCESS_KEY_ID = "sentinel-access-value";
    process.env.R2_SECRET_ACCESS_KEY = "sentinel-secret-value";
    process.env.R2_BUCKET = bucket;
  }
});

function assign(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function csv(id: string, confidence: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "t225-cli-"));
  const file = path.join(dir, "rows.csv");
  const header = "id,english_name,local_names,search_synonyms,category,subcategory,origin_countries,product_type,common_brands,unit,common_pack_sizes,typical_weight_g,storage,perishable,description,image_url,image_source_page,image_license,image_author,sources,confidence,notes";
  const cols = Array.from({ length: 22 }, () => "");
  cols[0] = id;
  cols[1] = id;
  cols[20] = confidence;
  writeFileSync(file, `${header}\n${cols.join(",")}\n`);
  return file;
}

async function asAdmin<T>(prisma: PrismaClient, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx as unknown as PrismaClient);
  });
}
