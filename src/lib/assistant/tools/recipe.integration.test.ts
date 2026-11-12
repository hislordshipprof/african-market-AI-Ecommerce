import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import recipeBase from "../../../../prisma/recipe-base.json";
import { platform, storeScoped } from "../../db";
import { testPrismaClient } from "../../test-prisma";
import { createFakeAnthropicFetch, type FakeAnthropicStep } from "../messages-api-double";
import { createAssistantModel } from "../model";
import { seedRecipeBase, type SeedRecipe } from "../recipe-base";
import { RECIPE_LOOKUPS_PER_STORE_DAY, WEB_SEARCH_MICROS, takeLookupSlot } from "../recipes";
import type { AssistantContext } from "./execute";
import { getRecipe } from "./recipe";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => fn,
  revalidateTag: () => {},
}));

const hasDb = !!process.env.DATABASE_URL;
const base = recipeBase as SeedRecipe[];

interface Placed { ingredient: string; amount?: string; listingId: string; variantId: string; backupVariantId?: string }
interface RecipeOutput {
  ok: boolean;
  code?: string;
  askServings?: boolean;
  lookedUp?: boolean;
  source?: string;
  basedOn?: string;
  inStock: Placed[];
  lowOrOut: Placed[];
  notCarried: string[];
}

function lookupStep(dish: string, ingredients: string[]): FakeAnthropicStep {
  return {
    kind: "tool",
    toolName: "report_ingredients",
    toolInput: { dish_name: dish, ingredients, source_url: "https://recipes.example/kelewele" },
    webSearch: {
      query: `${dish} recipe`,
      results: [{ url: "https://recipes.example/kelewele", title: dish }],
    },
  };
}

describe.skipIf(!hasDb)("get_recipe", () => {
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  let ctxA: AssistantContext;
  let rice = { listingId: "", variantId: "" };
  let derica = { listingId: "", variantId: "" };
  const suffix = randomUUID().slice(0, 8);
  const dish = `kelewele ${suffix}`;

  async function listing(storeId: string, masterProductId: string, name: string, confidence = 1) {
    const row = await storeScoped(storeId).listing.create({
      data: { storeId, masterProductId, customName: name, price: 500, stockMode: "unlimited", confidence, frozen: false, perishable: false },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: row.id, label: "Each", price: 500, weightG: 100 },
    });
    return { listingId: row.id, variantId: variant.id };
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    await seedRecipeBase(raw, base);
    storeA = (await raw.store.create({ data: { slug: `recipe-a-${suffix}`, name: "Recipe A", themePreset: "palm-and-shea" } })).id;
    storeB = (await raw.store.create({ data: { slug: `recipe-b-${suffix}`, name: "Recipe B", themePreset: "palm-and-shea" } })).id;
    rice = await listing(storeA, "rice-parboiled-long-grain", `Parboiled rice ${suffix}`);
    await listing(storeA, "tomato-paste-gino", `Gino tomato paste ${suffix}`, 0.4);
    derica = await listing(storeA, "tomato-paste-de-rica", `De Rica tomato paste ${suffix}`);
    await listing(storeB, "pepper-scotch-bonnet", `Scotch bonnet ${suffix}`);
    const cart = await storeScoped(storeA).cart.create({ data: { storeId: storeA, source: "ai" } });
    const conversation = await storeScoped(storeA).aiConversation.create({
      data: { storeId: storeA, cartId: cart.id, model: "claude-haiku-5-5", messages: [] },
    });
    ctxA = { storeId: storeA, cartId: cart.id, conversationId: conversation.id, actorUserId: null };
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("ASSISTANT_MODEL", "");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await platform.recipe.deleteMany({ where: { key: { startsWith: "kelewele " } } });
    for (const id of [storeA, storeB].filter(Boolean)) {
      await storeScoped(id).cart.deleteMany({});
      await storeScoped(id).listing.deleteMany({});
    }
    await raw.store.deleteMany({ where: { id: { in: [storeA, storeB].filter(Boolean) } } });
    await raw.$disconnect();
  });

  it("seeds at least ten curated dishes across the five regions, each ingredient on a real master product", async () => {
    expect(base.length).toBeGreaterThanOrEqual(10);
    expect(new Set(base.map((recipe) => recipe.cuisine))).toEqual(
      new Set(["West African", "East African", "Central African", "Southern African", "Caribbean"]),
    );
    const curated = await raw.recipe.findMany({ where: { origin: "curated" }, include: { ingredients: true } });
    expect(curated.length).toBeGreaterThanOrEqual(base.length);
    const mapped = base.flatMap((recipe) => recipe.ingredients.flatMap((row) => row.masterProductId ?? []));
    const stored = curated.flatMap((recipe) => recipe.ingredients.flatMap((row) => row.masterProductId ?? []));
    expect(new Set(stored)).toEqual(new Set(mapped));
    await expect(seedRecipeBase(raw, [{ name: "Broken", servings: 2, ingredients: [{ name: "x", masterProductId: "no-such-product", qty: 1, unit: "each" }] }]))
      .rejects.toThrow("no-such-product");
  });

  it("scales a seeded dish to the servings and groups it for this store only", async () => {
    const fake = createFakeAnthropicFetch({ steps: [{ kind: "error" }] });
    const result = await getRecipe(ctxA, { dish: "Jollof", servings: 12 }, {
      lookupModel: createAssistantModel({ fetch: fake.fetch }),
    }) as unknown as RecipeOutput;
    expect(fake.requests).toHaveLength(0);
    expect(result.ok).toBe(true);
    expect(result.basedOn).toBe("common recipes");
    expect(result.inStock).toEqual([
      expect.objectContaining({ ingredient: "rice", amount: "6 cup", ...rice }),
    ]);
    expect(result.lowOrOut).toEqual([
      expect.objectContaining({ ingredient: "tomato paste", amount: "280 g", backupVariantId: derica.variantId }),
    ]);
    // Store B sells scotch bonnet; store A does not, so it is not carried here.
    expect(result.notCarried).toContain("scotch bonnet pepper");
    expect(result.notCarried).toContain("onion");
  });

  it("asks for servings when they are unclear, without searching or looking up", async () => {
    const fake = createFakeAnthropicFetch({ steps: [lookupStep("Kelewele", ["ripe plantain"])] });
    const result = await getRecipe(ctxA, { dish }, { lookupModel: createAssistantModel({ fetch: fake.fetch }) });
    expect(result).toEqual({ ok: true, askServings: true, dish });
    expect(fake.requests).toHaveLength(0);
  });

  it("looks up a dish not in the base once, matches it to this store, saves it, and counts the search in spend", async () => {
    const before = await raw.assistantSpendDay.findUnique({ where: { day: new Date(new Date().toISOString().slice(0, 10)) } });
    const fake = createFakeAnthropicFetch({ steps: [lookupStep("Kelewele", ["Rice", "ripe plantain", "ginger", "rice"])] });
    const first = await getRecipe(ctxA, { dish, servings: 4 }, { lookupModel: createAssistantModel({ fetch: fake.fetch }) }) as unknown as RecipeOutput;
    expect(fake.requests).toHaveLength(1);
    expect((fake.requests[0].body?.tools as Array<{ type?: string }>).map((item) => item.type)).toContain("web_search_20250305");
    expect(first).toMatchObject({ ok: true, lookedUp: true, source: "https://recipes.example/kelewele" });
    expect(first.inStock.map((item) => item.listingId)).toEqual([rice.listingId]);
    expect(first.notCarried).toEqual(["ripe plantain", "ginger"]);
    const after = await raw.assistantSpendDay.findUnique({ where: { day: new Date(new Date().toISOString().slice(0, 10)) } });
    expect((after?.costMicros ?? BigInt(0)) - (before?.costMicros ?? BigInt(0))).toBeGreaterThanOrEqual(WEB_SEARCH_MICROS);

    const again = createFakeAnthropicFetch({ steps: [{ kind: "error" }] });
    const second = await getRecipe(ctxA, { dish: dish.toUpperCase(), servings: 8 }, { lookupModel: createAssistantModel({ fetch: again.fetch }) }) as unknown as RecipeOutput;
    expect(again.requests).toHaveLength(0);
    expect(second).toMatchObject({ ok: true, lookedUp: false, source: "https://recipes.example/kelewele" });
    expect(second.inStock.map((item) => item.listingId)).toEqual([rice.listingId]);
  });

  it("caps web lookups per store per day and makes no call past the cap", async () => {
    const day = new Date(`2031-0${1 + (Number.parseInt(suffix.slice(0, 2), 16) % 9)}-15T12:00:00Z`);
    for (let index = 0; index < RECIPE_LOOKUPS_PER_STORE_DAY; index += 1) {
      expect(await takeLookupSlot(storeA, day)).toBe(true);
    }
    const fake = createFakeAnthropicFetch({ steps: [lookupStep("Kelewele", ["ripe plantain"])] });
    const capped = await getRecipe(ctxA, { dish: `${dish} capped`, servings: 2 }, {
      lookupModel: createAssistantModel({ fetch: fake.fetch }),
      now: () => day,
    });
    expect(capped).toMatchObject({ ok: false, code: "lookup_limit" });
    expect(fake.requests).toHaveLength(0);
    expect(await takeLookupSlot(storeB, day)).toBe(true);
  });
});
