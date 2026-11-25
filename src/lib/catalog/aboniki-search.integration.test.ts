vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: () => {} }));
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { parse } from "csv-parse/sync";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { upsertMasterProduct, type CsvRow } from "../../../prisma/master-catalog-upsert";
import { platformAdmin, storeScoped } from "../db";
import { listingsByCategory, searchListings } from "../storefront/service";
import { subcategoryIdForSlug } from "./category-tree";

const hasDb = !!process.env.DATABASE_URL;

// #861 AC3: Aboniki balm opens Health & Wellness, and shoppers who type "abonaki" or "aboniki" find it
// through the synonyms the master catalogue CSV loads.
describe.skipIf(!hasDb)("Aboniki balm in Health & Wellness (#861)", () => {
  let raw: PrismaClient;
  const tag = randomUUID().slice(0, 8);
  const productId = `aboniki-${tag}`;
  let storeId = "";
  let listingId = "";

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    const rows: CsvRow[] = parse(fs.readFileSync(path.resolve(__dirname, "../../../research/catalog/master-catalog.csv")), { columns: true });
    const row = { ...rows.find((candidate) => candidate.id === "aboniki-balm")!, id: productId, english_name: `Aboniki balm ${tag}` };
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await upsertMasterProduct(tx, row, subcategoryIdForSlug(row.category), { statusOnCreate: "active", confidence: "high", imageUrl: null });
    });
    storeId = (await raw.store.create({ data: { slug: `aboniki-${tag}`, name: "Aboniki store", themePreset: "palm-and-shea" } })).id;
    listingId = (await storeScoped(storeId).listing.create({
      data: { storeId, masterProductId: productId, customName: null, price: 400, stockMode: "unlimited", confidence: 0.9, active: true },
    })).id;
  });

  afterAll(async () => {
    if (storeId) {
      await storeScoped(storeId).listing.deleteMany({});
      await raw.store.deleteMany({ where: { id: storeId } });
    }
    await platformAdmin.productSynonym.deleteMany({ where: { productId } });
    await platformAdmin.masterProduct.deleteMany({ where: { id: productId } });
    await raw?.$disconnect();
  });

  it("files it under Health & Wellness > Balms & Ointments", async () => {
    expect((await platformAdmin.masterProduct.findUniqueOrThrow({ where: { id: productId } })).categoryId).toBe("sub_balms_ointments");
    expect((await listingsByCategory(storeId, "health-and-wellness")).listings.map((listing) => listing.id)).toEqual([listingId]);
    expect((await listingsByCategory(storeId, "balms-and-ointments")).listings.map((listing) => listing.id)).toEqual([listingId]);
  });

  it("finds it for both spellings through the synonym table", async () => {
    for (const term of ["abonaki", "aboniki"]) {
      const hits = await searchListings(storeId, term);
      expect(hits.map((hit) => hit.id), term).toEqual([listingId]);
    }
    const synonyms = await platformAdmin.productSynonym.findMany({ where: { productId }, select: { term: true } });
    expect(synonyms.map((synonym) => synonym.term)).toEqual(expect.arrayContaining(["abonaki", "aboniki"]));
  });
});
