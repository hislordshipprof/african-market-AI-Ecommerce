import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: () => {}, revalidatePath: () => {} }));

import { Prisma, type PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdmin, platformAdminTransaction, storeScopedRawQuery, storeScopedTransaction } from "./db";
import { submitStoreApplication } from "./store-application/service";
import { findRecipe, saveLookedUpRecipe } from "./assistant/recipes";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("store applications and the recipe base: a store-scoped client cannot read applications or write recipes (#713)", () => {
  const stamp = Date.now().toString(36);
  const email = `rls-apply-${stamp}@example.com`;
  const lookupDish = `rls lookup ${stamp}`;
  let raw: PrismaClient;
  let storeId = "";
  let recipeId = "";

  beforeAll(async () => {
    raw = testPrismaClient();
    storeId = (await raw.store.create({ data: { slug: `apply-rls-${stamp}`, name: "Apply RLS", themePreset: "palm-and-shea" } })).id;
    const phone = `555${String(Date.now()).slice(-7)}`;
    const submitted = await submitStoreApplication({
      businessName: `RLS Apply ${stamp}`, storeType: "african", addressLine1: "1 Main St", city: "Houston", state: "TX", zip: "77002",
      ownerName: "Ada", email, phone, website: "", offersPickup: "on", planChoice: "undecided",
    }, `192.0.2.1-${stamp}`);
    expect(submitted).toEqual({ ok: true });
    recipeId = await platformAdminTransaction(async (tx) => (await tx.recipe.create({
      data: { key: `rls curated ${stamp}`, name: `RLS curated ${stamp}`, origin: "curated", ingredients: { create: [{ position: 0, name: "rice" }] } },
    })).id);
  });

  afterAll(async () => {
    await platformAdmin.storeApplication.deleteMany({ where: { email: { in: [email, `planted-${stamp}@example.com`] } } });
    await platformAdminTransaction((tx) => tx.recipe.deleteMany({ where: { key: { in: [`rls curated ${stamp}`, `rls planted ${stamp}`, lookupDish] } } }));
    await raw.store.deleteMany({ where: { id: storeId } });
    await raw.$disconnect();
  });

  it("the public /sell path stores an application that only the platform admin reads", async () => {
    expect(await platformAdmin.storeApplication.count({ where: { email } })).toBe(1);
    const seen = await storeScopedRawQuery<{ id: string }>(storeId, Prisma.sql`SELECT id FROM store_applications WHERE email = ${email}`);
    expect(seen).toEqual([]);
    const updated = await storeScopedTransaction(storeId, (tx) => tx.$executeRaw`UPDATE store_applications SET status = 'approved' WHERE email = ${email}`);
    expect(updated).toBe(0);
    // FORCE: the owning login is held to the same policies (it has no BYPASSRLS on lanes and CI).
    expect(await raw.storeApplication.count({ where: { email } })).toBe(0);
  });

  it("an insert outside the admin cannot plant a decided application", async () => {
    await expect(storeScopedTransaction(storeId, (tx) => tx.$executeRaw`
      INSERT INTO store_applications (id, business_name, store_type, address_line1, city, state, zip, owner_name, email, phone, status, store_id, updated_at)
      VALUES (${`rls-${stamp}`}, 'Planted', 'african', '1 Main St', 'Houston', 'TX', '77002', 'Eve', ${`planted-${stamp}@example.com`}, '+15550000000', 'pending', ${storeId}, now())`)).rejects.toThrow(/row-level security|42501/i);
  });

  it("a store-scoped client reads the recipe base but cannot add, change or delete a dish", async () => {
    const read = await storeScopedRawQuery<{ id: string }>(storeId, Prisma.sql`SELECT id FROM recipes WHERE id = ${recipeId}`);
    expect(read).toEqual([{ id: recipeId }]);
    await expect(storeScopedTransaction(storeId, (tx) => tx.$executeRaw`
      INSERT INTO recipes (id, key, name, origin) VALUES (${`rls-r-${stamp}`}, ${`rls planted ${stamp}`}, 'Planted', 'lookup')`)).rejects.toThrow(/row-level security|42501/i);
    await expect(storeScopedTransaction(storeId, (tx) => tx.$executeRaw`
      INSERT INTO recipe_ingredients (id, recipe_id, position, name) VALUES (${`rls-i-${stamp}`}, ${recipeId}, 9, 'planted')`)).rejects.toThrow(/row-level security|42501/i);
    expect(await storeScopedTransaction(storeId, (tx) => tx.$executeRaw`UPDATE recipes SET name = 'Changed' WHERE id = ${recipeId}`)).toBe(0);
    expect(await storeScopedTransaction(storeId, (tx) => tx.$executeRaw`DELETE FROM recipe_ingredients WHERE recipe_id = ${recipeId}`)).toBe(0);
    expect(await storeScopedTransaction(storeId, (tx) => tx.$executeRaw`DELETE FROM recipes WHERE id = ${recipeId}`)).toBe(0);
    // FORCE: the owning login cannot change the recipe base outside the admin either.
    expect((await raw.recipe.updateMany({ where: { id: recipeId }, data: { name: "Owner changed" } })).count).toBe(0);
    expect((await raw.recipeIngredient.deleteMany({ where: { recipeId } })).count).toBe(0);
    const kept = await platformAdminTransaction((tx) => tx.recipe.findUniqueOrThrow({ where: { id: recipeId }, include: { ingredients: true } }));
    expect(kept).toMatchObject({ name: `RLS curated ${stamp}`, ingredients: [{ name: "rice" }] });
  });

  it("the assistant's lookup writer still saves a looked-up dish", async () => {
    const saved = await saveLookedUpRecipe(lookupDish, { name: lookupDish, ingredients: ["onion", "pepper"], sourceUrl: "https://recipes.example/rls" });
    expect(saved).toMatchObject({ origin: "lookup", ingredients: [{ name: "onion" }, { name: "pepper" }] });
    expect((await findRecipe(lookupDish))?.sourceUrl).toBe("https://recipes.example/rls");
  });
});
