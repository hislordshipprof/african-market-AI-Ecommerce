vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: () => {} }));
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { storeScoped } from "../db";
import { searchCatalog } from "../assistant/tools/execute";
import { searchListingMatches } from "../copilot/search";
import { searchListings } from "./service";

const hasDb = !!process.env.DATABASE_URL;

// #493: pg_trgm finds no trigrams in Ge'ez script under a C locale, so typos scored 0.
describe.skipIf(!hasDb)("search for a Ge'ez-script name", () => {
  let raw: PrismaClient;
  let storeId = "";
  let cartId = "";
  let conversationId = "";
  let doroWat = "";

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    storeId = (await raw.store.create({
      data: { slug: `geez-search-${randomUUID().slice(0, 8)}`, name: "Geez Search", themePreset: "palm-and-shea" },
    })).id;
    const scoped = storeScoped(storeId);
    const listing = (name: string) => scoped.listing.create({
      data: { storeId, customName: name, price: 900, stockMode: "unlimited", confidence: 0.9 },
    });
    doroWat = (await listing("ዶሮ ወጥ")).id;
    await listing("Egusi Seeds");
    cartId = (await scoped.cart.create({ data: { storeId, source: "manual" } })).id;
    conversationId = (await scoped.aiConversation.create({
      data: { storeId, cartId, model: "claude-haiku-5-5", messages: [] },
    })).id;
  });

  afterAll(async () => {
    if (storeId) {
      await storeScoped(storeId).cart.deleteMany({});
      await storeScoped(storeId).listing.deleteMany({});
      await raw.store.deleteMany({ where: { id: storeId } });
    }
    await raw?.$disconnect();
  });

  it.each([
    ["the exact name", "ዶሮ ወጥ"],
    ["one word of it", "ዶሮ"],
    ["a one-character typo", "ዶሮ ወፕ"],
  ])("storefront, assistant search_catalog and copilot search find it from %s", async (_, query) => {
    const storefront = await searchListings(storeId, query);
    expect(storefront.map((hit) => hit.id)).toEqual([doroWat]);

    const assistant = await searchCatalog({ storeId, cartId, conversationId, actorUserId: null }, { query });
    const items = (assistant as unknown as { items: Array<{ listingId: string }> }).items;
    expect(items.map((item) => item.listingId)).toEqual([doroWat]);

    const copilot = await searchListingMatches(storeId, query);
    expect(copilot.listings.map((listing) => listing.id)).toEqual([doroWat]);
  });
});
