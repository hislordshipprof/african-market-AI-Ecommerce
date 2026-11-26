import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import { PRODUCTS } from "../../../prisma/seed-demo-catalog";
import { AISLES, OLD_AISLE_DEFAULT_SUBCATEGORY, OLD_AISLE_SLUGS, RETIRED_AISLE_IDS, SUBCATEGORIES, subcategoryIdForSlug } from "./category-tree";

const ROOT = path.resolve(__dirname, "../../..");
const csv: Array<{ id: string; category: string }> = parse(fs.readFileSync(path.join(ROOT, "research/catalog/master-catalog.csv")), { columns: true });
const migration = fs.readFileSync(path.join(ROOT, "prisma/migrations/20261208000000_category_tree_16_aisles/migration.sql"), "utf8");

/** The `(...)` tuples of one VALUES list in the migration, as arrays of SQL literals. */
function valuesAfter(marker: string): string[][] {
  const start = migration.indexOf(marker);
  const body = migration.slice(start + marker.length, migration.indexOf("\n  ) AS v(", start));
  return [...body.matchAll(/^\s+\((.*)\),?$/gm)].map((match) => match[1].split(/, (?=(?:[^']*'[^']*')*[^']*$)/).map((cell) => cell.replace(/^'|'$/g, "").replace(/''/g, "'")));
}

describe("the category tree (#861)", () => {
  it("has the 16 aisles in the approved order", () => {
    expect(AISLES.map((aisle) => aisle.name)).toEqual([
      "Tubers & Roots", "Fresh Produce", "Fufu, Flours & Swallow", "Rice, Grains & Beans", "Soup Ingredients",
      "Spices & Seasonings", "Oils, Sauces & Condiments", "Fish & Meat", "Frozen", "Canned & Packaged",
      "Breakfast & Dairy", "Snacks & Sweets", "Drinks", "Health & Wellness", "Beauty & Personal Care", "Household & Kitchen",
    ]);
  });

  it("gives every category a unique id, name and slug, and no old aisle slug to a live category", () => {
    const all = [...AISLES, ...SUBCATEGORIES];
    for (const key of ["id", "name", "slug"] as const) expect(new Set(all.map((row) => row[key])).size).toBe(all.length);
    const live = new Set(all.map((row) => row.slug));
    for (const [oldSlug, target] of Object.entries(OLD_AISLE_SLUGS)) {
      expect(live.has(oldSlug)).toBe(false);
      expect(AISLES.map((aisle) => aisle.slug)).toContain(target);
    }
  });

  it("sends every old aisle's leftover rows to a subcategory, and retires no aisle the tree still uses", () => {
    for (const target of Object.values(OLD_AISLE_DEFAULT_SUBCATEGORY)) expect(SUBCATEGORIES.map((sub) => sub.id)).toContain(target);
    for (const id of RETIRED_AISLE_IDS) {
      expect(Object.keys(OLD_AISLE_DEFAULT_SUBCATEGORY)).toContain(id);
      expect(AISLES.map((aisle) => aisle.id)).not.toContain(id);
    }
  });

  it("files every master catalogue row in a subcategory, with the row counts per aisle from section 5", () => {
    const counts: Record<string, number> = {};
    for (const row of csv) {
      const sub = SUBCATEGORIES.find((candidate) => candidate.id === subcategoryIdForSlug(row.category));
      expect(sub, row.id).toBeDefined();
      const aisle = AISLES.find((candidate) => candidate.id === sub!.aisleId)!.name;
      counts[aisle] = (counts[aisle] ?? 0) + 1;
    }
    expect(counts).toEqual({
      "Tubers & Roots": 8, "Fresh Produce": 29, "Fufu, Flours & Swallow": 44, "Rice, Grains & Beans": 36, "Soup Ingredients": 36,
      "Spices & Seasonings": 66, "Oils, Sauces & Condiments": 28, "Fish & Meat": 30, Frozen: 52, "Canned & Packaged": 19,
      "Breakfast & Dairy": 37, "Snacks & Sweets": 39, Drinks: 41, "Health & Wellness": 4, "Beauty & Personal Care": 16, "Household & Kitchen": 16,
    });
    const health = csv.filter((row) => SUBCATEGORIES.find((sub) => sub.slug === row.category)?.aisleId === "cat_health_wellness").map((row) => row.id);
    expect(health.sort()).toEqual(["aboniki-balm", "alum-stone", "bitter-kola", "sea-moss-dried"]);
  });

  it("the migration moves each product to the subcategory the seed files it under, so a deploy's re-seed moves nothing back", () => {
    const moved = Object.fromEntries(valuesAfter("UPDATE master_products mp SET category_id = v.subcategory_id, updated_at = now()\n  FROM (VALUES\n").map(([id, sub]) => [id, sub]));
    const seeded = Object.fromEntries([
      ...csv.map((row) => [row.id, subcategoryIdForSlug(row.category)]),
      ...PRODUCTS.map((product) => [product.id, product.categoryId]),
    ]);
    expect(moved).toEqual(seeded);
  });

  it("the migration creates the same aisles and subcategories as the seed", () => {
    const aisles = valuesAfter("INSERT INTO categories (id, name, slug, local_name, image_url, sort_order, tax_code, updated_at)\n  SELECT v.*, now() FROM (VALUES\n");
    expect(aisles.map(([id, name, slug, , , sortOrder, taxCode]) => ({ id, name, slug, sortOrder: Number(sortOrder), taxCode }))).toEqual(
      AISLES.map((aisle, index) => ({ id: aisle.id, name: aisle.name, slug: aisle.slug, sortOrder: index + 1, taxCode: aisle.taxCode })),
    );
    const subs = valuesAfter("INSERT INTO categories (id, name, slug, local_name, image_url, sort_order, parent_id, tax_code, updated_at)\n  SELECT v.*, now() FROM (VALUES\n");
    expect(subs.map(([id, name, slug, , , , parentId, taxCode]) => ({ id, name, slug, parentId, taxCode }))).toEqual(
      SUBCATEGORIES.map((sub) => ({ id: sub.id, name: sub.name, slug: sub.slug, parentId: sub.aisleId, taxCode: sub.taxCode })),
    );
    for (const [oldId, sub] of Object.entries(OLD_AISLE_DEFAULT_SUBCATEGORY)) expect(migration).toContain(`"${oldId}": "${sub}"`);
  });
});
