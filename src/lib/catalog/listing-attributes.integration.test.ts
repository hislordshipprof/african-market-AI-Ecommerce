import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScopedTransaction } from "../db";
import { checkNeed } from "./attributes";
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
});
