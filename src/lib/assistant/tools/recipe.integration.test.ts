import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import recipeBase from "../../../../prisma/recipe-base.json";
import { platform, platformAdmin, storeScoped, storeScopedTransaction } from "../../db";
import { testPrismaClient } from "../../test-prisma";
import { createFakeAnthropicFetch, type FakeAnthropicStep } from "../messages-api-double";
import { createAssistantModel } from "../model";
import { seedRecipeBase, type SeedRecipe } from "../recipe-base";
import { WEB_SEARCH_MICROS } from "../cost";
import { RECIPE_LOOKUPS_PER_STORE_DAY, saveLookedUpRecipe, takeLookupSlot } from "../recipes";
import { failNextSpendWrites } from "../spend";
import type { AssistantContext } from "./execute";
import { setShopperNeeds, type AssistantContext as Ctx } from "./execute";
import { getRecipe } from "./recipe";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => fn,
  revalidateTag: () => {},
}));

const hasDb = !!process.env.DATABASE_URL;
const base = recipeBase as SeedRecipe[];

interface Placed { ingredient: string; covers?: string[]; amount?: string; listingId: string; variantId: string; backupVariantId?: string; cannotConfirm?: boolean; needs?: Record<string, string> }
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
  excluded?: string[];
  preferences?: string[];
}

function lookupStep(dish: string, ingredients: string[], sourceUrl = "https://recipes.example/kelewele"): FakeAnthropicStep {
  return {
    kind: "tool",
    toolName: "report_ingredients",
    toolInput: { dish_name: dish, ingredients, source_url: sourceUrl },
    webSearch: {
      query: `${dish} recipe`,
      results: [{ url: sourceUrl, title: dish }],
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
  const ingredientIds: string[] = [];

  async function conversation(storeId: string): Promise<Ctx> {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId, source: "ai" } });
    const talk = await storeScoped(storeId).aiConversation.create({ data: { storeId, cartId: cart.id, model: "claude-haiku-5-5", messages: [] } });
    return { storeId, cartId: cart.id, conversationId: talk.id, actorUserId: null };
  }

  /** The store states the listing's full ingredient list and no allergens. */
  async function known(storeId: string, listingId: string, ingredients: string[]) {
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.listingAttributes.create({ data: { listingId, storeId, ingredientsStatus: "known", allergensStatus: "known", allergens: [] } });
      await tx.listingIngredient.createMany({ data: ingredients.map((ingredientId) => ({ listingId, ingredientId, storeId })) });
    });
  }

  async function listing(storeId: string, masterProductId: string, name: string, confidence = 1) {
    const row = await storeScoped(storeId).listing.create({
      data: { storeId, masterProductId, customName: name, price: 500, stockMode: "unlimited", confidence, frozen: false, perishable: false },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: row.id, label: "Each", price: 500, weightG: 100 },
    });
    return { listingId: row.id, variantId: variant.id };
  }

  async function spentToday(): Promise<bigint> {
    const row = await raw.assistantSpendDay.findUnique({ where: { day: new Date(new Date().toISOString().slice(0, 10)) } });
    return row?.costMicros ?? BigInt(0);
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
    await platform.recipe.deleteMany({ where: { key: { startsWith: "egusi stew " } } });
    await platform.recipe.deleteMany({ where: { key: { startsWith: "ዶሮ ወጥ " } } });
    for (const id of [storeA, storeB].filter(Boolean)) {
      await storeScoped(id).cart.deleteMany({});
      await storeScoped(id).listing.deleteMany({});
    }
    await raw.store.deleteMany({ where: { id: { in: [storeA, storeB].filter(Boolean) } } });
    await platformAdmin.ingredient.deleteMany({ where: { id: { in: ingredientIds } } });
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

  it("saves a dish named in another script once and serves it from the base the next time", async () => {
    const doro = `ዶሮ ወጥ ${suffix}`;
    const fake = createFakeAnthropicFetch({ steps: [lookupStep("ዶሮ ወጥ", ["rice"], "https://recipes.example/doro")] });
    const first = await getRecipe(ctxA, { dish: doro, servings: 4 }, { lookupModel: createAssistantModel({ fetch: fake.fetch }) });
    expect(first).toMatchObject({ ok: true, lookedUp: true, source: "https://recipes.example/doro" });
    expect(await raw.recipe.count({ where: { key: doro } })).toBe(1);
    const again = createFakeAnthropicFetch({ steps: [{ kind: "error" }] });
    const second = await getRecipe(ctxA, { dish: doro, servings: 4 }, { lookupModel: createAssistantModel({ fetch: again.fetch }) });
    expect(again.requests).toHaveLength(0);
    expect(second).toMatchObject({ ok: true, lookedUp: false, source: "https://recipes.example/doro" });
  });

  it("takes no lookup slot and makes no search for a name with no letters or digits", async () => {
    const day = new Date("2033-04-15T12:00:00Z");
    const fake = createFakeAnthropicFetch({ steps: [lookupStep("Kelewele", ["rice"])] });
    const result = await getRecipe(ctxA, { dish: "!!!", servings: 2 }, { lookupModel: createAssistantModel({ fetch: fake.fetch }), now: () => day });
    expect(result).toMatchObject({ ok: false, code: "recipe_not_found" });
    expect(fake.requests).toHaveLength(0);
    for (let index = 0; index < RECIPE_LOOKUPS_PER_STORE_DAY; index += 1) {
      expect(await takeLookupSlot(storeA, day)).toBe(true);
    }
  });

  it("never lets a looked-up dish take over a curated dish's name", async () => {
    const stew = `egusi stew ${suffix}`;
    const fake = createFakeAnthropicFetch({ steps: [lookupStep("Egusi soup", ["egusi", "palm oil"], "https://recipes.example/egusi")] });
    const looked = await getRecipe(ctxA, { dish: stew, servings: 4 }, { lookupModel: createAssistantModel({ fetch: fake.fetch }) });
    expect(looked).toMatchObject({ ok: true, lookedUp: true });
    const saved = await raw.recipe.findUniqueOrThrow({ where: { key: stew } });
    expect(saved.aliases).not.toContain("egusi soup");
    const again = createFakeAnthropicFetch({ steps: [{ kind: "error" }] });
    const curated = await getRecipe(ctxA, { dish: "Egusi soup", servings: 6 }, { lookupModel: createAssistantModel({ fetch: again.fetch }) });
    expect(curated).toMatchObject({ ok: true, lookedUp: false, recipe: "Egusi soup", source: "the store's recipe base" });
  });

  it("continues a search turn that pauses without reporting, on the same lookup", async () => {
    const day = new Date("2032-03-15T12:00:00Z");
    const before = await spentToday();
    const pause: FakeAnthropicStep = { kind: "pause", webSearch: { query: "kelewele recipe", results: [{ url: "https://recipes.example/first", title: "Kelewele" }] } };
    const fake = createFakeAnthropicFetch({ steps: [pause, lookupStep("Kelewele", ["rice"])] });
    const result = await getRecipe(ctxA, { dish: `${dish} paused`, servings: 2 }, {
      lookupModel: createAssistantModel({ fetch: fake.fetch }),
      now: () => day,
    });
    expect(result).toMatchObject({ ok: true, lookedUp: true });
    expect(fake.requests).toHaveLength(2);
    const resent = fake.requests[1].body?.messages as Array<{ role: string; content: Array<{ type: string }> }>;
    expect(resent.at(-1)?.role).toBe("assistant");
    expect(resent.at(-1)?.content.map((block) => block.type)).toContain("web_search_tool_result");
    expect((await spentToday()) - before).toBeGreaterThanOrEqual(WEB_SEARCH_MICROS * BigInt(2));
    for (let index = 1; index < RECIPE_LOOKUPS_PER_STORE_DAY; index += 1) {
      expect(await takeLookupSlot(storeA, day)).toBe(true);
    }
    expect(await takeLookupSlot(storeA, day)).toBe(false);
  });

  it("keeps a paid lookup when the spend write fails once, and records the search on the retry", async () => {
    const before = await spentToday();
    // The metering write for the lookup call (tokens and search) fails once, then its retry lands.
    failNextSpendWrites(1);
    const fake = createFakeAnthropicFetch({ steps: [lookupStep("Kelewele", ["rice"])] });
    const result = await getRecipe(ctxA, { dish: `${dish} spend`, servings: 2 }, { lookupModel: createAssistantModel({ fetch: fake.fetch }) });
    failNextSpendWrites(0);
    expect(result).toMatchObject({ ok: true, lookedUp: true });
    expect((await spentToday()) - before).toBeGreaterThanOrEqual(WEB_SEARCH_MICROS);
  });

  it("keeps a paid lookup whose report is too long, trimmed to the name length and ingredient cap", async () => {
    const long = `${dish} long`;
    const many = ["rice", "a".repeat(90), ...Array.from({ length: 40 }, (_, index) => `spice ${index}`)];
    const fake = createFakeAnthropicFetch({ steps: [lookupStep("K".repeat(90), many)] });
    const result = await getRecipe(ctxA, { dish: long, servings: 2 }, { lookupModel: createAssistantModel({ fetch: fake.fetch }) });
    expect(result).toMatchObject({ ok: true, lookedUp: true });
    const saved = await raw.recipe.findUniqueOrThrow({ where: { key: long }, include: { ingredients: true } });
    expect(saved.ingredients).toHaveLength(25);
    expect(Math.max(saved.name.length, ...saved.ingredients.map((row) => row.name.length))).toBe(60);
  });

  it("records the searches Anthropic reports even when the response cannot be read", async () => {
    const before = await spentToday();
    const broken: typeof fetch = async () =>
      Response.json({
        id: "msg_broken",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: "not a list",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 2, server_tool_use: { web_search_requests: 2 } },
      });
    const result = await getRecipe(ctxA, { dish: `${dish} broken`, servings: 2 }, { lookupModel: createAssistantModel({ fetch: broken }) });
    expect(result).toMatchObject({ ok: false, code: "recipe_not_found" });
    expect((await spentToday()) - before).toBeGreaterThanOrEqual(WEB_SEARCH_MICROS * BigInt(2));
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

  it("leaves out ingredients whose every item fails the saved constraints, with no name matching", async () => {
    const [onion, tomato, grain] = await Promise.all(["onion", "tomato", "rice"].map((name) =>
      platformAdmin.ingredient.create({ data: { name: `${name} ${suffix}` } })));
    ingredientIds.push(onion.id, tomato.id, grain.id);
    const mix = await listing(storeA, "gino-pepper-onion-paste", `Gino pepper and onion mix ${suffix}`);
    const pastes = await storeScoped(storeA).listing.findMany({ where: { customName: { contains: `tomato paste ${suffix}` } }, select: { id: true } });
    await known(storeA, mix.listingId, [onion.id, tomato.id]);
    await known(storeA, rice.listingId, [grain.id]);
    for (const paste of pastes) await known(storeA, paste.id, [tomato.id]);

    const plain = await getRecipe(ctxA, { dish: "Jollof", servings: 6 }) as unknown as RecipeOutput;
    expect(plain.inStock.map((item) => item.ingredient)).toContain("onion");

    const ruledOut = await conversation(storeA);
    await setShopperNeeds(ruledOut, { avoid_ingredients: [`onion ${suffix}`, `rice ${suffix}`] });
    const result = await getRecipe(ruledOut, { dish: "Jollof", servings: 6 }) as unknown as RecipeOutput;
    const offered = [...result.inStock, ...result.lowOrOut];
    expect(offered.map((item) => item.ingredient)).not.toContain("onion");
    expect(offered.map((item) => item.listingId)).not.toContain(rice.listingId);
    expect(result.notCarried).not.toContain("onion");
    expect(result.excluded).toEqual(expect.arrayContaining(["onion", "rice"]));
    expect(offered.map((item) => item.ingredient)).toContain("tomato paste");

    // "No yellow onion, not fresh tomato": both name only a form of a known ingredient, so the assistant asks.
    const jollof = await conversation(storeA);
    const asked = await setShopperNeeds(jollof, { avoid_ingredients: [`yellow onion ${suffix}`, `fresh tomato ${suffix}`] }) as unknown as { ask: Array<{ term: string; closest: string[] }> };
    expect(asked.ask.map((row) => [row.term, row.closest.includes(`${row.term.split(" ")[1]} ${suffix}`)])).toEqual([
      [`yellow onion ${suffix}`, true],
      [`fresh tomato ${suffix}`, true],
    ]);
    const beforeAnswer = await getRecipe(jollof, { dish: "Jollof", servings: 6 }) as unknown as RecipeOutput;
    expect(beforeAnswer.inStock.map((item) => item.ingredient)).toContain("onion");
    expect(beforeAnswer.preferences).toEqual([`yellow onion ${suffix}`, `fresh tomato ${suffix}`]);
    // The customer answers all onion: onion is left out; tomato paste stays, as fresh tomato is only a preference.
    await setShopperNeeds(jollof, { avoid_ingredients: [`onion ${suffix}`] });
    const narrower = await getRecipe(jollof, { dish: "Jollof", servings: 6 }) as unknown as RecipeOutput;
    expect([...narrower.inStock, ...narrower.lowOrOut].map((item) => item.ingredient)).not.toContain("onion");
    expect(narrower.excluded).toEqual(["onion"]);
    expect(narrower.preferences).toEqual([`fresh tomato ${suffix}`]);
    expect(narrower.lowOrOut.map((item) => item.ingredient)).toContain("tomato paste");
  });

  it("marks an item it cannot confirm against the constraints instead of offering it as a fit", async () => {
    await listing(storeA, "curry-powder-nigerian", `Curry powder ${suffix}`);
    const ctx = await conversation(storeA);
    await setShopperNeeds(ctx, { avoid_allergens: ["peanuts"] });
    const result = await getRecipe(ctx, { dish: "Jollof", servings: 6 }) as unknown as RecipeOutput;
    const curry = [...result.inStock, ...result.lowOrOut].find((item) => item.ingredient === "curry powder");
    expect(curry).toMatchObject({ cannotConfirm: true, needs: { peanuts: "unknown" } });
  });

  it("filters each ingredient's search before the result cap, so excluded items cannot crowd out an allowed one", async () => {
    const store = (await raw.store.create({ data: { slug: `recipe-crowd-${suffix}`, name: "Recipe crowd", themePreset: "palm-and-shea" } })).id;
    const allergens = async (listingId: string, found: string[]) => storeScopedTransaction(store, (tx) =>
      tx.listingAttributes.create({ data: { listingId, storeId: store, allergensStatus: "known", allergens: found } }));
    for (let i = 0; i < 55; i += 1) {
      const row = await listing(store, "rice-parboiled-long-grain", `Crowdgrain ${suffix} a${String(i).padStart(2, "0")}`);
      await allergens(row.listingId, ["peanuts"]);
    }
    const allowed = await listing(store, "rice-parboiled-long-grain", `Crowdgrain ${suffix} zz`);
    await allergens(allowed.listingId, []);
    await saveLookedUpRecipe(`kelewele crowd ${suffix}`, { name: `kelewele crowd ${suffix}`, ingredients: [`crowdgrain ${suffix}`], sourceUrl: "https://recipes.example/crowd" });
    const ctx = await conversation(store);
    await setShopperNeeds(ctx, { avoid_allergens: ["peanuts"] });
    try {
      const result = await getRecipe(ctx, { dish: `kelewele crowd ${suffix}`, servings: 2 }) as unknown as RecipeOutput;
      expect([...result.inStock, ...result.lowOrOut].map((item) => item.listingId)).toEqual([allowed.listingId]);
      expect(result.excluded ?? []).toEqual([]);
    } finally {
      await storeScoped(store).cart.deleteMany({});
      await storeScoped(store).listing.deleteMany({});
      await raw.store.delete({ where: { id: store } });
    }
  });
});
