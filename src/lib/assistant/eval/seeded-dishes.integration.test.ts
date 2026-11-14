import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import recipeBase from "../../../../prisma/recipe-base.json";
import { testPrismaClient } from "../../test-prisma";
import { seedRecipeBase, type SeedRecipe } from "../recipe-base";
import { saveLookedUpRecipe } from "../recipes";
import { loadDataset, loadFixture, validateDataset, validateFixture } from "./dataset";
import { unseededDishes } from "./fixture-store";
import type { EvalCase } from "./types";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => fn,
  revalidateTag: () => {},
}));

const hasDb = !!process.env.DATABASE_URL;
const base = recipeBase as SeedRecipe[];

function dishCase(name: string, core: Array<{ label: string; options: string[] }>): EvalCase {
  return {
    id: `dish-${randomUUID().slice(0, 8)}`,
    category: "recipe-to-cart",
    turns: [`${name} for 4 people.`, "Yes, add those."],
    mustHave: [],
    mayHave: [],
    gaps: [],
    addsFromTurn: 2,
    dish: { name, core, askServings: false },
  };
}

describe.skipIf(!hasDb)("dishes the #146 eval uses", () => {
  const fixture = validateFixture(loadFixture());

  beforeAll(async () => {
    await seedRecipeBase(testPrismaClient(), base);
  });

  it("every dish in the committed dataset resolves from the curated recipe base, with an ingredient store A sells for each core item", async () => {
    const dataset = validateDataset(loadDataset(), fixture, { full: true });
    expect(dataset.filter((item) => item.dish).length).toBeGreaterThan(0);
    expect(await unseededDishes(dataset, fixture, base)).toEqual([]);
  });

  it("names a dataset dish whose seed declaration is gone, though its curated row from an earlier seed is still in the database", async () => {
    const dataset = validateDataset(loadDataset(), fixture, { full: true });
    const withoutBreakfast = base.filter((recipe) => !(recipe.aliases ?? []).includes("ethiopian breakfast"));
    expect(withoutBreakfast).toHaveLength(base.length - 1);
    expect(await unseededDishes(dataset, fixture, withoutBreakfast)).toEqual(["Ethiopian breakfast"]);
  });

  it("names a recipe ingredient store A has no listing for", async () => {
    const dataset = validateDataset(loadDataset(), fixture, { full: true });
    const noHoney = { ...fixture, listings: fixture.listings.filter((listing) => listing.masterProductId !== "honey-malab") };
    expect(await unseededDishes(dataset, noHoney, base)).toEqual(["Ethiopian breakfast: honey"]);
  });

  it("names a dish the recipe base does not answer", async () => {
    const name = `Unseeded stew ${randomUUID().slice(0, 8)}`;
    expect(await unseededDishes([dishCase(name, [{ label: "rice", options: ["rice-parboiled-long-grain"] }])], fixture, base)).toEqual([name]);
  });

  it("names a core item the seeded recipe has no ingredient for", async () => {
    const cases = [dishCase("Jollof", [{ label: "rice", options: ["rice-parboiled-long-grain"] }, { label: "teff", options: ["teff-flour-ivory"] }])];
    expect(await unseededDishes(cases, fixture, base)).toEqual(["Jollof: teff"]);
  });

  it("a declared dish the database answers only with an online lookup does not count as seeded", async () => {
    const name = `Looked up stew ${randomUUID().slice(0, 8)}`;
    await saveLookedUpRecipe(name, { name, ingredients: ["rice"], sourceUrl: "https://recipes.example/stew" });
    const declared: SeedRecipe = { name, servings: 2, ingredients: [{ name: "rice", masterProductId: "rice-parboiled-long-grain", qty: 1, unit: "cup" }] };
    expect(await unseededDishes([dishCase(name, [{ label: "rice", options: ["rice-parboiled-long-grain"] }])], fixture, [declared])).toEqual([name]);
  });
});
