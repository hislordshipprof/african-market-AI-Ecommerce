vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: () => {} }));
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { platformAdmin, platformAdminTransaction, storeScoped } from "../db";
import { cookTonight } from "./cook-tonight";

const hasDb = !!process.env.DATABASE_URL;

// #862 AC5: home's Cook tonight offers the store's recipes it can fill, each with every item it has in stock.
describe.skipIf(!hasDb)("Cook tonight", () => {
  let raw: PrismaClient;
  const tag = randomUUID().slice(0, 8);
  let storeId = "";
  let emptyStoreId = "";
  let categoryId = "";
  const productIds: string[] = [];
  const recipeIds: string[] = [];
  const variantOf: Record<string, string> = {};

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    const store = (name: string) => raw.store.create({ data: { slug: `cook-${name}-${tag}`, name, themePreset: "palm-and-shea" } });
    storeId = (await store("a")).id;
    emptyStoreId = (await store("b")).id;
    categoryId = (await platformAdmin.category.create({ data: { name: `Cook ${tag}`, slug: `cook-${tag}`, sortOrder: 991 } })).id;
    const product = async (name: string) => {
      const id = (await platformAdmin.masterProduct.create({ data: { name: `${name} ${tag}`, categoryId } })).id;
      productIds.push(id);
      return id;
    };
    const [seed, leaf, stock, pepper, rare] = await Promise.all(["Zxseed", "Zxleaf", "Zxstock", "Zxpepper", "Zxrare"].map(product));
    const sell = async (masterProductId: string, name: string, price: number) => {
      const listing = await storeScoped(storeId).listing.create({
        data: { storeId, masterProductId, categoryId, price, stockMode: "unlimited", confidence: 0.9, active: true },
      });
      variantOf[name] = (await storeScoped(storeId).listingVariant.create({ data: { listingId: listing.id, label: "1 lb", price, weightG: 450 } })).id;
    };
    await sell(seed, "seed", 899);
    await sell(leaf, "leaf", 499);
    await sell(stock, "stock", 299);
    await sell(pepper, "pepper", 199);
    const recipe = async (name: string, ingredients: [string, string | null][]) => {
      const row = await platformAdminTransaction((tx) => tx.recipe.create({
        data: {
          key: `${name} ${tag}`.toLowerCase(), name: `${name} ${tag}`, origin: "curated", servings: 4,
          ingredients: { create: ingredients.map(([ingredient, masterProductId], position) => ({ position, name: `${ingredient} ${tag}`, masterProductId })) },
        },
      }));
      recipeIds.push(row.id);
    };
    await recipe("Zx soup", [["zxseed", seed], ["zxleaf", leaf], ["zxstock", stock], ["zxonion", null]]);
    await recipe("Zx stew", [["zxpepper", pepper], ["zxstock", stock], ["zxrare", rare]]);
    await recipe("Zx thin", [["zxrare", rare], ["zxonion", null], ["zxpepper", pepper]]);
  });

  afterAll(async () => {
    if (recipeIds.length) await platformAdminTransaction((tx) => tx.recipe.deleteMany({ where: { id: { in: recipeIds } } }));
    for (const id of [storeId, emptyStoreId].filter(Boolean)) {
      await storeScoped(id).listingVariant.deleteMany({});
      await storeScoped(id).listing.deleteMany({});
      await raw.store.deleteMany({ where: { id } });
    }
    if (productIds.length) await platformAdmin.masterProduct.deleteMany({ where: { id: { in: productIds } } });
    if (categoryId) await platformAdmin.category.deleteMany({ where: { id: categoryId } });
    await raw?.$disconnect();
  });

  it("offers each dish the store has most of, fullest first, with its in-stock items and what it lacks", async () => {
    const dishes = (await cookTonight(storeId)).filter((dish) => dish.name.endsWith(tag));
    expect(dishes.map((dish) => dish.name)).toEqual([`Zx soup ${tag}`, `Zx stew ${tag}`]);
    const [soup, stew] = dishes;
    expect(soup.items.map((item) => item.variantId).sort()).toEqual([variantOf.seed, variantOf.leaf, variantOf.stock].sort());
    expect(soup.ingredientCount).toBe(4);
    expect(soup.missing).toEqual([`zxonion ${tag}`]);
    expect(soup.totalCents).toBe(899 + 499 + 299);
    expect(soup.servings).toBe(4);
    expect(stew.items.map((item) => item.variantId).sort()).toEqual([variantOf.pepper, variantOf.stock].sort());
  });

  it("hides a dish the store has less than half of", async () => {
    const names = (await cookTonight(storeId)).map((dish) => dish.name);
    expect(names).not.toContain(`Zx thin ${tag}`);
  });

  it("offers no dish to a store that sells none of the ingredients", async () => {
    expect((await cookTonight(emptyStoreId)).filter((dish) => dish.name.endsWith(tag))).toEqual([]);
  });

  it("offers at most three dishes", async () => {
    expect((await cookTonight(storeId)).length).toBeLessThanOrEqual(3);
  });
});
