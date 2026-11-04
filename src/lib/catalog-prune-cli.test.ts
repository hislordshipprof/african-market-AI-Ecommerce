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
    const inheritedE2e = Object.keys(process.env).filter((key) => key.startsWith("E2E_"));
    const savedE2e: Record<string, string | undefined> = {};
    for (const key of inheritedE2e) savedE2e[key] = process.env[key];
    const clearHosted = () => {
      delete process.env.CI;
      delete process.env.VERCEL;
      delete process.env.VERCEL_ENV;
      assign("NODE_ENV", "test");
      delete process.env.DATABASE_URL_UNPOOLED;
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("E2E_")) delete process.env[key];
      }
    };
    const cases: Array<{ mode: "dry-run" | "bucket"; reason: string; apply?: () => void }> = [];
    const hosted: Array<[string, string, string]> = [
      ["CI", "true", "CI is set"],
      ["CI", "1", "CI is set"],
      ["VERCEL", "1", "VERCEL is set"],
      ["NODE_ENV", "production", "NODE_ENV is production"],
      ["VERCEL_ENV", "production", "VERCEL_ENV is production"],
      ["VERCEL_ENV", "preview", "VERCEL_ENV is preview"],
      ["E2E_STORE_OVERRIDE", "1", "E2E_STORE_OVERRIDE is set"],
    ];
    for (const mode of ["dry-run", "bucket"] as const) {
      for (const [key, value, reason] of hosted) {
        cases.push({
          mode,
          reason,
          apply: () => { assign(key, value); },
        });
      }
      for (const key of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) {
        cases.push({
          mode,
          reason: `missing ${key}`,
          apply: () => { delete process.env[key]; },
        });
      }
      cases.push({
        mode,
        reason: "database host is localhost",
        apply: () => { process.env.DIRECT_URL = "postgresql://app_owner:app_owner@localhost:5434/app"; },
      });
      cases.push({
        mode,
        reason: "database host is 127.0.0.1",
        apply: () => { process.env.DIRECT_URL = "postgresql://app_owner:app_owner@127.0.0.1:5432/app"; },
      });
      cases.push({
        mode,
        reason: "database host is [::1]",
        apply: () => { process.env.DIRECT_URL = "postgresql://app_owner:app_owner@[::1]:5432/app"; },
      });
      cases.push({
        mode,
        reason: "database name starts with lane_",
        apply: () => { process.env.DIRECT_URL = "postgresql://user:sentinel-secret-value@ep-test.neon.tech:5432/lane_demo"; },
      });
      cases.push({
        mode,
        reason: "missing or malformed",
        apply: () => { process.env.DATABASE_URL_UNPOOLED = "not a url"; },
      });
      cases.push({
        mode,
        reason: "missing or malformed",
        apply: () => {
          delete process.env.DIRECT_URL;
          delete process.env.DATABASE_URL_UNPOOLED;
        },
      });
    }
    cases.push({ mode: "dry-run", reason: "Accepted forms", apply: () => { process.env.SEED_PRUNE_R2 = "1"; } });
    try {
      for (const entry of cases) {
        restore();
        for (const key of inheritedE2e) delete process.env[key];
        clearHosted();
        setR2("lane-bucket");
        process.env.SEED_PRUNE_R2 = entry.mode === "dry-run" ? "dry-run" : "lane-bucket";
        entry.apply?.();
        await expect(runSeed(), entry.reason).rejects.toThrow(new RegExp(entry.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        const after = await prisma.$queryRaw<Array<{ updated_at: Date }>>`
          SELECT updated_at FROM stores WHERE slug = 'mama-ngozi'
        `;
        expect(new Date(after[0]!.updated_at).getTime()).toBe(new Date(before[0]!.updated_at).getTime());
        expect(`${after[0]!.updated_at}`).not.toContain("sentinel-secret-value");
      }
    } finally {
      restore();
      for (const key of inheritedE2e) {
        if (process.env[key] === undefined && savedE2e[key] !== undefined) process.env[key] = savedE2e[key];
      }
      await prisma.$disconnect();
    }
  }, 90_000);

  it("off-mode hosted CI and preview keep their supported seed behaviour", async () => {
    const { runSeed } = await import("../../prisma/seed");
    const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
    const previewId = `t225-preview-${Date.now().toString(36)}`;
    const productionId = `t225-prod-${Date.now().toString(36)}`;
    const savedAdmin = {
      flag: process.env.SEED_TEST_ADMIN,
      password: process.env.SEED_ADMIN_PASSWORD,
      totp: process.env.SEED_ADMIN_TOTP_SECRET,
      auth: process.env.BETTER_AUTH_SECRET,
    };
    restore();
    delete process.env.SEED_PRUNE_R2;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    process.env.CI = "true";
    process.env.SEED_TEST_ADMIN = "1";
    process.env.SEED_ADMIN_PASSWORD = "CiTestPass99!";
    process.env.SEED_ADMIN_TOTP_SECRET = "JBSWY3DPEHPK3PXP";
    if (!process.env.BETTER_AUTH_SECRET) {
      process.env.BETTER_AUTH_SECRET = "ci-e2e-test-secret-do-not-use-in-prod";
    }
    process.env.VERCEL_ENV = "preview";
    const logs: string[] = [];
    try {
      await runSeed({
        csvPath: csv(previewId, "high"),
        log: (line) => logs.push(line),
      });
      const preview = await asAdmin(prisma, (tx) => tx.masterProduct.findUnique({ where: { id: previewId } }));
      expect(preview?.id).toBe(previewId);
      expect(logs.join("\n")).toContain("Catalog prune skipped");
      const admin = await prisma.user.findUnique({ where: { email: "admin@platform.test" } });
      expect(admin?.email).toBe("admin@platform.test");
      process.env.VERCEL_ENV = "production";
      delete process.env.SEED_PRUNE_R2;
      delete process.env.SEED_TEST_ADMIN;
      const skipped: string[] = [];
      await runSeed({
        csvPath: csv(productionId, "high"),
        log: (line) => skipped.push(line),
      });
      const production = await asAdmin(prisma, (tx) => tx.masterProduct.findUnique({ where: { id: productionId } }));
      expect(production).toBeNull();
      expect(skipped.join("\n")).toContain("Skipping master catalog seed in production");
      const beforeRefusal = await prisma.$queryRaw<Array<{ updated_at: Date }>>`
        SELECT updated_at FROM stores WHERE slug = 'mama-ngozi'
      `;
      process.env.VERCEL_ENV = "production";
      process.env.SEED_PRUNE_R2 = "dry-run";
      setR2("lane-bucket");
      await expect(runSeed({
        csvPath: csv(`${productionId}-opt`, "high"),
        log: () => undefined,
      })).rejects.toThrow(/VERCEL_ENV is production|CI is set|database host/);
      const afterRefusal = await prisma.$queryRaw<Array<{ updated_at: Date }>>`
        SELECT updated_at FROM stores WHERE slug = 'mama-ngozi'
      `;
      expect(new Date(afterRefusal[0]!.updated_at).getTime()).toBe(new Date(beforeRefusal[0]!.updated_at).getTime());
    } finally {
      await asAdmin(prisma, (tx) => tx.masterProduct.deleteMany({ where: { id: { in: [previewId] } } }));
      await prisma.$disconnect();
      assign("SEED_TEST_ADMIN", savedAdmin.flag);
      assign("SEED_ADMIN_PASSWORD", savedAdmin.password);
      assign("SEED_ADMIN_TOTP_SECRET", savedAdmin.totp);
      assign("BETTER_AUTH_SECRET", savedAdmin.auth);
      restore();
    }
  }, 120_000);

  it("pre-seed references survive demo reseeding with prune requested", async () => {
    const { runSeed } = await import("../../prisma/seed");
    const { createFakeR2 } = await import("./catalog-prune-fake-r2");
    const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
    const prior = await prisma.store.findUnique({
      where: { slug: "mama-ngozi" },
      select: { ownerPhotoUrl: true },
    });
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
        await tx.store.update({
          where: { slug: "mama-ngozi" },
          data: { ownerPhotoUrl: prior?.ownerPhotoUrl ?? null },
        });
      });
      const restored = await prisma.store.findUnique({
        where: { slug: "mama-ngozi" },
        select: { ownerPhotoUrl: true },
      });
      expect(restored?.ownerPhotoUrl ?? null).toBe(prior?.ownerPhotoUrl ?? null);
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
