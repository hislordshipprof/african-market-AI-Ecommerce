import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { resolveDirectUrl } from "./env";
import { createFakeR2 } from "./catalog-prune-fake-r2";
import { loadProductionCatalog } from "../../prisma/seed-production";

// #802: a production deploy loads the master catalogue and nothing else.
const hasDb = !!process.env.DATABASE_URL;
const RUN = `t802${Date.now().toString(36)}`;
const HEADER = "id,english_name,local_names,search_synonyms,category,subcategory,origin_countries,product_type,common_brands,unit,common_pack_sizes,typical_weight_g,storage,perishable,description,image_url,image_source_page,image_license,image_author,sources,confidence,notes";
const ENV_KEYS = [
  "VERCEL_ENV", "SEED_PRUNE_R2", "SEED_TEST_ADMIN", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET",
] as const;

type Row = { id: string; name: string; localNames?: string; synonyms?: string; imageUrl?: string; confidence?: string };

function csv(rows: Row[]): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "t802-")), "rows.csv");
  const lines = rows.map((row) => {
    const cols = Array.from({ length: 22 }, () => "");
    cols[0] = row.id;
    cols[1] = row.name;
    cols[2] = row.localNames ?? "";
    cols[3] = row.synonyms ?? "";
    cols[4] = "spices";
    cols[15] = row.imageUrl ?? "";
    cols[20] = row.confidence ?? "high";
    return cols.map((col) => (col.includes(",") ? `"${col}"` : col)).join(",");
  });
  writeFileSync(file, `${[HEADER, ...lines].join("\n")}\n`);
  return file;
}

async function asAdmin<T>(prisma: PrismaClient, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx as unknown as PrismaClient);
  });
}

const WRITES = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"]);

/** The same client, recording each model it writes. Other test files seed demo data in parallel, so row counts would race. */
function recordingWrites(prisma: PrismaClient, written: Set<string>): PrismaClient {
  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (WRITES.has(operation)) written.add(model);
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
}

describe.skipIf(!hasDb)("production catalogue load (lane DB, VERCEL_ENV=production)", () => {
  let prisma: PrismaClient;
  const saved: Record<string, string | undefined> = {};
  const productIds = [`${RUN}-a`, `${RUN}-b`, `${RUN}-c`];
  const actorId = `${RUN}-admin`;

  beforeAll(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    prisma = testPrismaClient(resolveDirectUrl());
    await prisma.user.create({ data: { id: actorId, name: "Catalogue admin", email: `${actorId}@test.example`, role: "platform_admin" } });
  });

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.VERCEL_ENV = "production";
  });

  afterAll(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    if (!prisma) return;
    await asAdmin(prisma, async (tx) => {
      await tx.auditLog.deleteMany({ where: { actorId } });
      await tx.productSynonym.deleteMany({ where: { productId: { in: productIds } } });
      await tx.masterProduct.deleteMany({ where: { id: { in: productIds } } });
    });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("loads products, synonyms, categories and the recipe base, and none of the demo data", async () => {
    const written = new Set<string>();
    const logs: string[] = [];
    await loadProductionCatalog(recordingWrites(prisma, written), {
      csvPath: csv([
        { id: productIds[0], name: "Ground Egusi", localNames: "agushi (yo, NG)", synonyms: "melon seed" },
        { id: productIds[1], name: "Review Row", confidence: "medium" },
      ]),
      log: (line) => logs.push(line),
    });

    const product = await asAdmin(prisma, (tx) => tx.masterProduct.findUnique({ where: { id: productIds[0] }, include: { synonyms: true } }));
    expect(product?.status).toBe("active");
    expect(product?.categoryId).toBe("cat_spices");
    expect(product?.synonyms.map((row) => row.term).sort()).toEqual(["agushi", "melon seed"]);
    const review = await asAdmin(prisma, (tx) => tx.masterProduct.findUnique({ where: { id: productIds[1] } }));
    expect(review?.status).toBe("needs_review");
    const category = await asAdmin(prisma, (tx) => tx.category.findUnique({ where: { id: "cat_spices" } }));
    expect(category?.slug).toBe("spices-and-seasonings");
    const recipes = await asAdmin(prisma, (tx) => tx.recipe.count({ where: { origin: "curated" } }));
    expect(recipes).toBeGreaterThan(0);
    expect(logs.join("\n")).toMatch(/Production catalogue load done \(\d+ curated recipes\)/);

    expect([...written].sort()).toEqual(["Category", "MasterProduct", "ProductSynonym", "Recipe", "RecipeIngredient"]);
  }, 120_000);

  it("a second deploy keeps what a platform admin edited and adds the rows the CSV gained", async () => {
    await asAdmin(prisma, async (tx) => {
      await tx.masterProduct.update({ where: { id: productIds[0] }, data: { name: "Egusi (admin name)" } });
      await tx.auditLog.create({
        data: {
          actorId, actorEmail: `${actorId}@test.example`, action: "catalog.product_edit",
          entityType: "master_product", entityId: productIds[0],
          before: { name: "Ground Egusi" }, after: { name: "Egusi (admin name)" },
        },
      });
    });
    const logs: string[] = [];
    await loadProductionCatalog(prisma, {
      csvPath: csv([
        { id: productIds[0], name: "Ground Egusi", localNames: "agushi (yo, NG)", synonyms: "melon seed" },
        { id: productIds[1], name: "Review Row", confidence: "medium" },
        { id: productIds[2], name: "New Row" },
      ]),
      log: (line) => logs.push(line),
    });

    const edited = await asAdmin(prisma, (tx) => tx.masterProduct.findUnique({ where: { id: productIds[0] } }));
    expect(edited?.name).toBe("Egusi (admin name)");
    const added = await asAdmin(prisma, (tx) => tx.masterProduct.findUnique({ where: { id: productIds[2] } }));
    expect(added?.name).toBe("New Row");
    expect(logs.join("\n")).toMatch(/Kept admin changes on [1-9]\d* product/);
  }, 120_000);

  it("refuses a prune in production before writing anything, whatever SEED_PRUNE_R2 says", async () => {
    for (const value of ["dry-run", "1", "lane-bucket"]) {
      process.env.SEED_PRUNE_R2 = value;
      process.env.R2_ACCOUNT_ID = "acct-t802";
      process.env.R2_ACCESS_KEY_ID = "sentinel-access-value";
      process.env.R2_SECRET_ACCESS_KEY = "sentinel-secret-value";
      process.env.R2_BUCKET = "lane-bucket";
      const fake = createFakeR2({ bucket: "lane-bucket", objects: [{ key: "catalog/orphan.jpg", lastModified: new Date(0) }] });
      const id = `${RUN}-prune-${value.replace(/\W/g, "")}`;
      await expect(loadProductionCatalog(prisma, { csvPath: csv([{ id, name: id }]), r2: fake, log: () => undefined }))
        .rejects.toThrow(/Refusing catalog prune: VERCEL_ENV is production/);
      expect(fake.objects().map((object) => object.key)).toEqual(["catalog/orphan.jpg"]);
      expect(await asAdmin(prisma, (tx) => tx.masterProduct.findUnique({ where: { id } }))).toBeNull();
    }
  });

  it("skips catalogue photos with a logged count when R2 is not configured", async () => {
    const logs: string[] = [];
    await loadProductionCatalog(prisma, {
      csvPath: csv([
        { id: productIds[0], name: "Ground Egusi", imageUrl: "https://example.test/egusi.jpg" },
        { id: productIds[2], name: "New Row", imageUrl: "https://example.test/new.jpg" },
      ]),
      log: (line) => logs.push(line),
    });
    expect(logs).toContain("Catalogue photos skipped: 2 (R2 is not configured)");
  }, 120_000);

  it("a failing R2 listing skips the photos and still loads the catalogue", async () => {
    process.env.R2_ACCOUNT_ID = "acct-t802";
    process.env.R2_ACCESS_KEY_ID = "sentinel-access-value";
    process.env.R2_SECRET_ACCESS_KEY = "sentinel-secret-value";
    process.env.R2_BUCKET = "lane-bucket";
    const broken = { send: async () => { throw new Error("R2 list denied"); } };
    const logs: string[] = [];
    await loadProductionCatalog(prisma, {
      csvPath: csv([{ id: productIds[2], name: "New Row (listing failed)", imageUrl: "https://example.test/new.jpg" }]),
      r2: broken,
      log: (line) => logs.push(line),
    });
    const row = await asAdmin(prisma, (tx) => tx.masterProduct.findUnique({ where: { id: productIds[2] } }));
    expect(row?.name).toBe("New Row (listing failed)");
    expect(logs.join("\n")).toContain("R2 listing failed");
    expect(logs).toContain("Catalogue photos skipped: 1 (R2 listing failed)");
  }, 120_000);
});
