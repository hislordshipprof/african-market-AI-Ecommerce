import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdminTransaction, storeScopedTransaction } from "../db";
import { checkNeed } from "./attributes";
import { resolveIngredients } from "./ingredients";
import { correctListingAttributes, listingAttributes } from "./listing-attributes";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t484-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!hasDb)("listing attributes: store owner corrections", () => {
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  let listingA = "";
  let productId = "";
  let onionId = "";
  const actor = { id: `${RUN}-owner`, email: `${RUN}@owner.test` };

  async function asAdmin<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return fn(tx as unknown as PrismaClient);
    });
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    await asAdmin(async (tx) => {
      await tx.user.create({ data: { id: actor.id, email: actor.email, name: "Owner", emailVerified: true } });
      storeA = (await tx.store.create({ data: { slug: `${RUN}-a`, name: `A ${RUN}`, themePreset: "palm-and-shea" } })).id;
      storeB = (await tx.store.create({ data: { slug: `${RUN}-b`, name: `B ${RUN}`, themePreset: "lagoon-and-coral" } })).id;
      onionId = (await tx.ingredient.create({
        data: { name: `${RUN} onion`, synonyms: { create: { term: `${RUN} alubosa`, language: "yo" } } },
      })).id;
      productId = (await tx.masterProduct.create({
        data: {
          name: `${RUN} suya spice`,
          status: "active",
          allergens: ["peanuts"],
          allergensStatus: "reviewed",
          dietaryStatus: "unknown",
        },
      })).id;
      listingA = (await tx.listing.create({
        data: { storeId: storeA, masterProductId: productId, price: 500, stockMode: "status", status: "in_stock" },
      })).id;
    });
  });

  afterAll(async () => {
    await asAdmin(async (tx) => {
      await tx.auditLog.deleteMany({ where: { storeId: { in: [storeA, storeB] } } });
      await tx.listing.deleteMany({ where: { storeId: { in: [storeA, storeB] } } });
      await tx.masterProduct.deleteMany({ where: { id: productId } });
      await tx.ingredient.deleteMany({ where: { name: { startsWith: RUN } } });
      await tx.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
      await tx.user.deleteMany({ where: { id: actor.id } });
    });
    await raw.$disconnect();
  });

  it("a listing inherits the master product's attributes until its owner corrects them", async () => {
    const before = await listingAttributes(storeA, listingA);
    expect(before!.allergens).toEqual({ status: "reviewed", values: ["peanuts"] });
    expect(checkNeed(before!, { requireClaims: ["halal"] })).toBe("cannot_confirm");

    const result = await correctListingAttributes(storeA, actor, listingA, {
      ingredients: { status: "known", names: [`${RUN} Alubosa`] },
      dietary: { status: "known", values: ["halal"] },
    });
    expect(result).toEqual({ ok: true });

    const after = await listingAttributes(storeA, listingA);
    expect(after).toEqual({
      ingredients: { status: "known", ingredientIds: [onionId] },
      allergens: { status: "reviewed", values: ["peanuts"] },
      dietary: { status: "known", values: ["halal"] },
    });
    expect(checkNeed(after!, { requireClaims: ["halal"], avoidIngredientIds: [onionId] })).toBe("excluded");

    const audits = await asAdmin((tx) => tx.auditLog.findMany({ where: { entityId: listingA, action: "listing.attributes_correct" } }));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ storeId: storeA, actorId: actor.id });
  });

  it("an ingredient name that matches no ingredient is refused and nothing changes", async () => {
    const before = await listingAttributes(storeA, listingA);
    const result = await correctListingAttributes(storeA, actor, listingA, {
      ingredients: { status: "known", names: [`${RUN} unobtainium`] },
    });
    expect(result).toEqual({ ok: false, error: `Unknown ingredient: ${RUN} unobtainium` });
    expect(await listingAttributes(storeA, listingA)).toEqual(before);
  });

  it("another store can neither read nor correct this listing's attributes", async () => {
    expect(await listingAttributes(storeB, listingA)).toBeNull();
    expect(await correctListingAttributes(storeB, actor, listingA, {
      allergens: { status: "known", values: [] },
    })).toEqual({ ok: false, error: "Listing not found" });
    const seenByB = await storeScopedTransaction(storeB, (tx) => tx.listingAttributes.findMany({ where: { listingId: listingA } }));
    expect(seenByB).toEqual([]);
    const forged = storeScopedTransaction(storeB, (tx) =>
      tx.listingAttributes.create({ data: { listingId: listingA, storeId: storeB, allergensStatus: "known" } }));
    await expect(forged).rejects.toThrow();
  });

  it("an owner's known ingredients with an empty or blank list are refused and nothing changes", async () => {
    const before = await listingAttributes(storeA, listingA);
    for (const names of [[], ["  ", ""]]) {
      expect(await correctListingAttributes(storeA, actor, listingA, { ingredients: { status: "known", names } })).toEqual({
        ok: false,
        error: "List at least one ingredient, or mark the ingredients as unknown",
      });
    }
    expect(await listingAttributes(storeA, listingA)).toEqual(before);
  });

  it("the safer value wins: an owner's 'none' plus an approved master read of peanuts shows peanuts", async () => {
    const setMaster = (data: Record<string, unknown>) =>
      asAdmin((tx) => tx.masterProduct.update({ where: { id: productId }, data }));
    await setMaster({ allergens: [], allergensStatus: "unknown", dietaryClaims: [], dietaryStatus: "unknown" });
    expect(await correctListingAttributes(storeA, actor, listingA, {
      allergens: { status: "known", values: [] },
      dietary: { status: "known", values: ["halal", "vegan"] },
    })).toEqual({ ok: true });
    expect((await listingAttributes(storeA, listingA))!.allergens).toEqual({ status: "known", values: [] });

    await setMaster({ allergens: ["peanuts"], allergensStatus: "reviewed", dietaryClaims: ["halal"], dietaryStatus: "reviewed" });
    const merged = (await listingAttributes(storeA, listingA))!;
    expect(merged.allergens).toEqual({ status: "known", values: ["peanuts"] });
    // A claim stands only if neither source contradicts it.
    expect(merged.dietary).toEqual({ status: "known", values: ["halal"] });
    expect(checkNeed(merged, { avoidAllergens: ["peanuts"] })).toBe("excluded");
    expect(checkNeed(merged, { requireClaims: ["vegan"] })).toBe("excluded");

    // An owner's unknown over a reviewed master is still unknown.
    expect(await correctListingAttributes(storeA, actor, listingA, { allergens: { status: "unknown", values: [] } })).toEqual({ ok: true });
    expect((await listingAttributes(storeA, listingA))!.allergens.status).toBe("unknown");
  });

  it("ingredients take the union of the owner's and the reviewed master's", async () => {
    const pepperId = await asAdmin(async (tx) => {
      const pepper = await tx.ingredient.create({ data: { name: `${RUN} pepper` } });
      await tx.masterProduct.update({ where: { id: productId }, data: { ingredientsStatus: "reviewed" } });
      await tx.masterProductIngredient.create({ data: { productId, ingredientId: pepper.id } });
      return pepper.id;
    });
    expect(await correctListingAttributes(storeA, actor, listingA, {
      ingredients: { status: "known", names: [`${RUN} onion`] },
    })).toEqual({ ok: true });
    const ingredients = (await listingAttributes(storeA, listingA))!.ingredients;
    expect(ingredients.status).toBe("known");
    expect(ingredients.ingredientIds.sort()).toEqual([onionId, pepperId].sort());
  });

  it("'Use catalog value' clears the owner's correction, with an audit row", async () => {
    expect(await correctListingAttributes(storeA, actor, listingA, {
      ingredients: { status: "catalog", names: [] },
      allergens: { status: "catalog", values: [] },
      dietary: { status: "catalog", values: [] },
    })).toEqual({ ok: true });
    const own = await storeScopedTransaction(storeA, (tx) => tx.listingAttributes.findUniqueOrThrow({ where: { listingId: listingA } }));
    expect(own).toMatchObject({ ingredientsStatus: null, allergensStatus: null, allergens: [], dietaryStatus: null, dietaryClaims: [] });
    const links = await storeScopedTransaction(storeA, (tx) => tx.listingIngredient.count({ where: { listingId: listingA } }));
    expect(links).toBe(0);
    const master = await asAdmin((tx) => tx.masterProduct.findUniqueOrThrow({ where: { id: productId } }));
    const shown = (await listingAttributes(storeA, listingA))!;
    expect(shown.allergens).toEqual({ status: "reviewed", values: master.allergens });
    expect(shown.dietary).toEqual({ status: "reviewed", values: master.dietaryClaims });
    const audits = await asAdmin((tx) => tx.auditLog.findMany({
      where: { entityId: listingA, action: "listing.attributes_correct" },
      orderBy: { createdAt: "desc" },
    }));
    expect(audits[0]!.after).toMatchObject({ allergensStatus: null, ingredientIds: [] });
  });

  it("two admins creating the same new ingredient at once both get its id", async () => {
    const name = `${RUN} ogiri`;
    let arrived = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => { release = resolve; });
    const create = () => platformAdminTransaction(async (tx) => {
      if (++arrived === 2) release();
      await together;
      return (await resolveIngredients(tx, [name], { create: true })).ids;
    });
    const [first, second] = await Promise.all([create(), create()]);
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
  });
});
