import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdmin, storeScoped } from "../db";
import { commitImport, generatePreview } from "./csv-import";
import type { Actor } from "./service";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `a782-${Date.now()}`;

// #782 AC1: a CSV category or aisle column puts each custom listing in a platform aisle.
describe.skipIf(!hasDb)("csv aisle column (lane DB)", () => {
  let raw: PrismaClient;
  let storeId = "";
  let userId = "";
  let actor: Actor;
  let masterId = "";

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    storeId = (await raw.store.create({
      data: { slug: `csv-aisle-${RUN}`, name: `CSV Aisle ${RUN}`, themePreset: "palm-and-shea" },
    })).id;
    const user = await raw.user.create({
      data: { id: crypto.randomUUID(), email: `csv-aisle-${RUN}@example.com`, name: "CSV Aisle", emailVerified: true },
    });
    userId = user.id;
    actor = { id: user.id, email: user.email };
    const vegetables = await raw.category.findUniqueOrThrow({ where: { slug: "leafy-greens-and-wrapping-leaves" } });
    masterId = (await platformAdmin.masterProduct.create({
      data: { name: `Aisle Ugu ${RUN}`, categoryId: vegetables.id, status: "active" },
    })).id;
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.$transaction([
      raw.$executeRaw`SET LOCAL ROLE app_user`,
      raw.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      raw.auditLog.deleteMany({ where: { storeId } }),
      raw.stockEvent.deleteMany({ where: { storeId } }),
      raw.listingVariant.deleteMany({ where: { listing: { storeId } } }),
      raw.listing.deleteMany({ where: { storeId } }),
      raw.listingImport.deleteMany({ where: { storeId } }),
      raw.masterProduct.deleteMany({ where: { id: masterId } }),
    ]);
    await raw.user.deleteMany({ where: { id: userId } });
    await raw.store.deleteMany({ where: { id: storeId } });
    await raw.$disconnect();
  });

  it("maps a row's aisle by platform category name, refuses an unknown one, and lets the master product's category win", async () => {
    const csv = [
      "name,price,weight,aisle",
      `Palm Oil ${RUN},9.99,1 kg,Oils & Butters`,
      `Egusi ${RUN},5.00,500 g,spices and seasonings`,
      `Plain Thing ${RUN},3.00,100 g,`,
      `Odd Thing ${RUN},3.00,100 g,Moon Rocks`,
      `Aisle Ugu ${RUN},2.00,200 g,Snacks`,
    ].join("\n");
    const preview = await generatePreview(storeId, csv, userId);
    expect(preview.newItems.map((item) => item.row)).toEqual([2, 3, 4]);
    expect(preview.newItems.map((item) => item.aisle)).toEqual(["Oils, Sauces & Condiments", "Spices & Seasonings", undefined]);
    expect(preview.errors).toEqual([
      expect.objectContaining({ row: 5, reason: expect.stringContaining('Unknown aisle: "Moon Rocks"') }),
    ]);
    expect(preview.matches.map((match) => match.row)).toEqual([6]);

    const result = await commitImport(
      storeId,
      preview.importToken,
      { matchedRows: [6], newItemRows: [2, 3, 4], ambiguousResolutions: [] },
      actor,
    );
    const stored = await storeScoped(storeId).listing.findMany({
      where: { id: { in: result.listingIds } },
      select: { customName: true, masterProductId: true, categoryId: true },
    });
    const byName = new Map(stored.map((listing) => [listing.customName ?? listing.masterProductId, listing.categoryId]));
    expect(byName.get(`Palm Oil ${RUN}`)).toBe("cat_oils");
    expect(byName.get(`Egusi ${RUN}`)).toBe("cat_spices");
    expect(byName.get(`Plain Thing ${RUN}`)).toBeNull();
    expect(byName.get(masterId)).toBeNull();
  });

  // #861: a cell names an aisle or a subcategory, as "Aisle > Subcategory" or the subcategory alone; an old
  // aisle's name still finds where it went.
  it("maps a row to a subcategory of the two-level tree", async () => {
    const csv = [
      "name,price,weight,aisle",
      `Aboniki ${RUN},3.00,25 g,Health & Wellness > Balms & Ointments`,
      `Red Oil ${RUN},9.99,1 kg,palm-oil`,
      `Cocoa Butter ${RUN},6.00,200 g,shea butter & natural butters`,
      `Malta ${RUN},2.00,330 g,Snacks`,
      `Wrong Pair ${RUN},2.00,330 g,Drinks > Palm Oil`,
    ].join("\n");
    const preview = await generatePreview(storeId, csv, userId);
    expect(preview.newItems.map((item) => item.aisle)).toEqual([
      "Health & Wellness > Balms & Ointments", "Oils, Sauces & Condiments > Palm Oil",
      "Beauty & Personal Care > Shea Butter & Natural Butters", "Snacks & Sweets",
    ]);
    expect(preview.errors).toEqual([
      expect.objectContaining({ row: 6, reason: expect.stringContaining('Unknown aisle: "Drinks > Palm Oil"') }),
    ]);
    const result = await commitImport(storeId, preview.importToken, { matchedRows: [], newItemRows: [2, 3, 4, 5], ambiguousResolutions: [] }, actor);
    const stored = await storeScoped(storeId).listing.findMany({ where: { id: { in: result.listingIds } }, select: { customName: true, categoryId: true } });
    expect(Object.fromEntries(stored.map((listing) => [listing.customName, listing.categoryId]))).toEqual({
      [`Aboniki ${RUN}`]: "sub_balms_ointments",
      [`Red Oil ${RUN}`]: "sub_palm_oil",
      [`Cocoa Butter ${RUN}`]: "sub_shea_natural_butters",
      [`Malta ${RUN}`]: "cat_snacks",
    });
  });

  it("finds an aisle for every row of the template the import page offers", async () => {
    const { LISTINGS_CSV_TEMPLATE } = await import("./csv-template");
    const preview = await generatePreview(storeId, LISTINGS_CSV_TEMPLATE, userId);
    expect(preview.errors).toEqual([]);
    expect(preview.newItems.map((item) => item.aisle)).toEqual([
      "Oils, Sauces & Condiments > Palm Oil", "Soup Ingredients > Egusi & Melon Seeds", "Fish & Meat > Stockfish",
    ]);
  });

  it("accepts a category column as the same thing as aisle", async () => {
    const preview = await generatePreview(storeId, `name,price,weight,category\nFufu ${RUN},4.00,1 lb,Tubers & Roots\n`, userId);
    expect(preview.unknownColumns).toEqual([]);
    expect(preview.newItems.map((item) => item.aisle)).toEqual(["Tubers & Roots"]);
  });
});
