import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { upsertMasterProduct, parseLocalNames, type CsvRow } from "../../prisma/master-catalog-upsert";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t126-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function row(id: string, over: Partial<CsvRow> = {}): CsvRow {
  return {
    id, english_name: `${RUN} Yam`, local_names: "Isu (Igbo, Nigeria)", search_synonyms: "white yam|yam tuber",
    category: "tubers", subcategory: "Yams", origin_countries: "Nigeria", product_type: "", common_brands: "",
    unit: "kg", common_pack_sizes: "", typical_weight_g: "1500", storage: "Ambient", perishable: "yes",
    description: "A tuber", image_url: "https://x.test/y.jpg", image_source_page: "", image_license: "CC0",
    image_author: "A", sources: "", confidence: "high", notes: "", ...over,
  };
}

describe("parseLocalNames", () => {
  it("splits term, language and region", () => {
    expect(parseLocalNames("Isu (Igbo, Nigeria)|Ewa")).toEqual([
      { term: "Isu", language: "Igbo", region: "Nigeria" },
      { term: "Ewa", language: null, region: null },
    ]);
  });
});

describe.skipIf(!hasDb)("upsertMasterProduct (DB integration)", () => {
  let raw: PrismaClient;
  const ids = [`${RUN}-a`, `${RUN}-b`];
  const asAdmin = <T,>(fn: (tx: PrismaClient) => Promise<T>) =>
    raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return fn(tx as unknown as PrismaClient);
    });

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
  });
  afterAll(async () => {
    await asAdmin(async (tx) => {
      await tx.productSynonym.deleteMany({ where: { productId: { in: ids } } });
      await tx.masterProduct.deleteMany({ where: { id: { in: ids } } });
    });
    await raw.$disconnect();
  });

  it("high-confidence variant: active, high, image set, synonyms written; re-run overwrites status but keeps image when none given", async () => {
    await asAdmin((tx) => upsertMasterProduct(tx, row(ids[0]), null, { statusOnCreate: "active", statusOnUpdate: "active", confidence: "high", imageUrl: "https://cdn.test/a.webp" }));
    const p = await asAdmin((tx) => tx.masterProduct.findUniqueOrThrow({ where: { id: ids[0] }, include: { synonyms: true } }));
    expect(p).toMatchObject({ status: "active", confidence: "high", imageUrl: "https://cdn.test/a.webp", weightG: 1500, perishable: true, frozen: false, unit: "kg", originCountries: "Nigeria" });
    expect(p.synonyms.map((s) => s.term).sort()).toEqual(["Isu", "white yam", "yam tuber"]);

    await asAdmin((tx) => tx.masterProduct.update({ where: { id: ids[0] }, data: { status: "rejected" } }));
    await asAdmin((tx) => upsertMasterProduct(tx, row(ids[0], { english_name: `${RUN} Yam2` }), null, { statusOnCreate: "active", statusOnUpdate: "active", confidence: "high", imageUrl: null }));
    const again = await asAdmin((tx) => tx.masterProduct.findUniqueOrThrow({ where: { id: ids[0] }, include: { synonyms: true } }));
    expect(again).toMatchObject({ status: "active", imageUrl: "https://cdn.test/a.webp", name: `${RUN} Yam2` });
    expect(again.synonyms).toHaveLength(3);

    // #89: a re-seed with edited synonyms drops the rows the CSV no longer names.
    await asAdmin((tx) => upsertMasterProduct(tx, row(ids[0], { local_names: "Ji (Igbo, Nigeria)", search_synonyms: "white yam" }), null, { statusOnCreate: "active", statusOnUpdate: "active", confidence: "high", imageUrl: null }));
    const edited = await asAdmin((tx) => tx.productSynonym.findMany({ where: { productId: ids[0] } }));
    expect(edited.map((s) => s.term).sort()).toEqual(["Ji", "white yam"]);
  });

  it("review variant: created needs_review with no image; re-seed never resets an approved status", async () => {
    await asAdmin((tx) => upsertMasterProduct(tx, row(ids[1], { confidence: " medium " }), null, { statusOnCreate: "needs_review", confidence: "medium", imageUrl: null }));
    expect(await asAdmin((tx) => tx.masterProduct.findUniqueOrThrow({ where: { id: ids[1] } }))).toMatchObject({ status: "needs_review", confidence: "medium", imageUrl: null });
    await asAdmin((tx) => tx.masterProduct.update({ where: { id: ids[1] }, data: { status: "active" } }));
    await asAdmin((tx) => upsertMasterProduct(tx, row(ids[1]), null, { statusOnCreate: "needs_review", confidence: "medium", imageUrl: null }));
    expect((await asAdmin((tx) => tx.masterProduct.findUniqueOrThrow({ where: { id: ids[1] } }))).status).toBe("active");
  });
});
