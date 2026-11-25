vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: () => {} }));
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { platformAdmin, storeScoped } from "../db";
import { popularSearches, searchListings, suggestSearch } from "./service";

const hasDb = !!process.env.DATABASE_URL;

// #835: the search box suggests as you type, only from what this store sells now.
describe.skipIf(!hasDb)("search suggestions", () => {
  let raw: PrismaClient;
  const tag = randomUUID().slice(0, 8);
  let storeId = "";
  let otherStoreId = "";
  let categoryId = "";
  let pepperId = "";

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    const store = (name: string) => raw.store.create({ data: { slug: `suggest-${name}-${tag}`, name, themePreset: "palm-and-shea" } });
    storeId = (await store("a")).id;
    otherStoreId = (await store("b")).id;
    categoryId = (await platformAdmin.category.create({ data: { name: `Oils ${tag}`, slug: `oils-${tag}`, sortOrder: 990 } })).id;
    pepperId = (await platformAdmin.masterProduct.create({
      data: { name: "Scotch Bonnet Pepper", categoryId, synonyms: { create: [{ term: "ata rodo" }] } },
    })).id;
    const listing = (customName: string | null, extra: { active?: boolean; masterProductId?: string; storeId?: string } = {}) =>
      storeScoped(extra.storeId ?? storeId).listing.create({
        data: { storeId: extra.storeId ?? storeId, customName, categoryId, price: 900, stockMode: "unlimited", confidence: 0.9, active: extra.active ?? true, masterProductId: extra.masterProductId },
      });
    await listing("Palm Oil");
    const cream = await listing("Palm Nut Cream");
    const wine = await listing("Palm Wine", { active: false });
    const kernel = await listing("Red Palm Kernel");
    await listing(null, { masterProductId: pepperId });
    await listing("Palm Sugar", { storeId: otherStoreId });
    const scoped = storeScoped(storeId);
    const customerId = (await scoped.customer.create({ data: { storeId, name: "Ada" } })).id;
    const orderId = (await scoped.order.create({ data: { storeId, number: 1, customerId, subtotalCents: 0, bufferCents: 0, totalAuthorizedCents: 0 } })).id;
    for (const [listingId, qtyOrdered] of [[cream.id, 3], [kernel.id, 1], [wine.id, 9]] as const) {
      const variant = await scoped.listingVariant.create({ data: { listingId, label: "1 jar", price: 900, weightG: 400 } });
      await scoped.orderLine.create({ data: { storeId, orderId, listingVariantId: variant.id, qtyOrdered, unitPriceCents: 900 } });
    }
  });

  afterAll(async () => {
    for (const id of [storeId, otherStoreId].filter(Boolean)) {
      await storeScoped(id).orderLine.deleteMany({});
      await storeScoped(id).order.deleteMany({});
      await storeScoped(id).customer.deleteMany({});
      await storeScoped(id).listingVariant.deleteMany({});
      await storeScoped(id).listing.deleteMany({});
      await raw.store.deleteMany({ where: { id } });
    }
    if (pepperId) await platformAdmin.masterProduct.deleteMany({ where: { id: pepperId } });
    if (categoryId) await platformAdmin.category.deleteMany({ where: { id: categoryId } });
    await raw?.$disconnect();
  });

  it("completes a prefix from this store's active listing names, with the matching aisle and products", async () => {
    const result = await suggestSearch(storeId, "palm");
    expect(result.suggestions.map((s) => s.text)).toEqual(["palm nut cream", "palm oil", "red palm kernel"]);
    expect(result.aisles).toEqual([{ name: `Oils ${tag}`, slug: `oils-${tag}` }]);
    expect(result.products.map((p) => p.name).sort()).toEqual(["Palm Nut Cream", "Palm Oil", "Red Palm Kernel"]);
  });

  it("shows the store's product name for a synonym or local-name match", async () => {
    const result = await suggestSearch(storeId, "ata");
    expect(result.suggestions).toEqual([{ text: "scotch bonnet pepper", via: "ata rodo" }]);
  });

  it("never suggests a completion that searches to 0 results", async () => {
    for (const prefix of ["pa", "pal", "palm", "palm n", "re", "at", "ata", "sc"]) {
      const { suggestions } = await suggestSearch(storeId, prefix);
      for (const { text } of suggestions) {
        expect((await searchListings(storeId, text)).length, `${prefix} → ${text}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps another store's listings out", async () => {
    const result = await suggestSearch(otherStoreId, "palm");
    expect(result.suggestions.map((s) => s.text)).toEqual(["palm sugar"]);
    expect((await suggestSearch(storeId, "sug")).suggestions).toEqual([]);
  });

  it("offers the store's most ordered listings it still sells for an empty box", async () => {
    expect(await popularSearches(storeId)).toEqual(["palm nut cream", "red palm kernel"]);
    expect(await popularSearches(otherStoreId)).toEqual([]);
  });
});
