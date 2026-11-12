// Action-layer tests for the store owner's attributes screen (#484). Only the request edges are faked
// (headers, redirect, Better Auth session, store resolution); requireStoreOwner and RLS run for real.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";

const state = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown>; session: Record<string, unknown> },
  store: null as null | Record<string, unknown>,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../auth", () => ({ auth: { api: { getSession: async () => state.session } } }));
vi.mock("../get-store", () => ({ getStore: async () => state.store }));

import { correctListingAttributesAction, getListingAttributesAction } from "./attribute-actions";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t484a-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

describe.skipIf(!hasDb)("listing attribute actions (DB integration, real auth guard)", () => {
  let raw: PrismaClient;
  let storeA: { id: string; slug: string };
  let storeB: { id: string; slug: string };
  const ownerA = { id: `${RUN}-ua`, email: `${RUN}-a@example.com` };
  const ownerB = { id: `${RUN}-ub`, email: `${RUN}-b@example.com` };
  const staff = { id: `${RUN}-us`, email: `${RUN}-s@example.com` };
  let productId = "";
  let listingId = "";

  async function asAdmin<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return fn(tx as unknown as PrismaClient);
    });
  }

  function signIn(user: { id: string; email: string }, store: { id: string; slug: string }) {
    state.session = { user: { ...user, twoFactorEnabled: true }, session: { twoFactorVerified: true } };
    state.store = store;
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    await asAdmin(async (tx) => {
      storeA = await tx.store.create({ data: { slug: `${RUN}-a`, name: "Attr A", themePreset: "palm-and-shea" } });
      storeB = await tx.store.create({ data: { slug: `${RUN}-b`, name: "Attr B", themePreset: "palm-and-shea" } });
      for (const user of [ownerA, ownerB, staff]) {
        await tx.user.create({ data: { ...user, name: user.id, emailVerified: true } });
      }
      await tx.storeMembership.create({ data: { storeId: storeA.id, userId: ownerA.id, role: "owner" } });
      await tx.storeMembership.create({ data: { storeId: storeB.id, userId: ownerB.id, role: "owner" } });
      await tx.storeMembership.create({ data: { storeId: storeA.id, userId: staff.id, role: "staff" } });
      await tx.ingredient.create({ data: { name: `${RUN} groundnut` } });
      productId = (await tx.masterProduct.create({
        data: { name: `${RUN} suya spice`, status: "active", allergens: ["peanuts"], allergensStatus: "reviewed" },
      })).id;
      await tx.attributeProposal.create({
        data: { productId, ingredientsRead: false, allergensRead: false, dietaryRead: true, dietaryClaims: ["halal"] },
      });
      listingId = (await tx.listing.create({
        data: { storeId: storeA.id, masterProductId: productId, price: 500, stockMode: "status", status: "in_stock" },
      })).id;
    });
  });

  afterAll(async () => {
    await asAdmin(async (tx) => {
      const stores = [storeA.id, storeB.id];
      await tx.auditLog.deleteMany({ where: { storeId: { in: stores } } });
      await tx.listing.deleteMany({ where: { storeId: { in: stores } } });
      await tx.masterProduct.deleteMany({ where: { id: productId } });
      await tx.ingredient.deleteMany({ where: { name: { startsWith: RUN } } });
      await tx.storeMembership.deleteMany({ where: { storeId: { in: stores } } });
      await tx.user.deleteMany({ where: { id: { in: [ownerA.id, ownerB.id, staff.id] } } });
      await tx.store.deleteMany({ where: { id: { in: stores } } });
    });
    await raw.$disconnect();
  });

  beforeEach(() => {
    state.session = null;
    state.store = storeA;
  });

  it("shows each group's status: reviewed, AI-proposed while unknown, unknown", async () => {
    signIn(ownerA, storeA);
    expect(await getListingAttributesAction(listingId)).toEqual({
      attributes: {
        ingredients: { status: "unknown", values: [], proposed: false, ownerSet: false },
        allergens: { status: "reviewed", values: ["peanuts"], proposed: false, ownerSet: false },
        dietary: { status: "unknown", values: [], proposed: true, ownerSet: false },
      },
    });
  });

  it("an owner saves a correction, with one audit row, and reads it back by name", async () => {
    signIn(ownerA, storeA);
    expect(await correctListingAttributesAction({
      listingId,
      ingredients: { status: "known", names: [`${RUN} Groundnut`] },
      allergens: { status: "known", values: ["peanuts", "sesame"] },
    })).toEqual({ success: true });
    const read = await getListingAttributesAction(listingId);
    expect(read.attributes).toMatchObject({
      ingredients: { status: "known", values: [`${RUN} groundnut`] },
      allergens: { status: "known", values: ["peanuts", "sesame"], ownerSet: true },
      dietary: { status: "unknown", ownerSet: false },
    });
    const audits = await asAdmin((tx) => tx.auditLog.findMany({ where: { entityId: listingId, action: "listing.attributes_correct" } }));
    expect(audits).toHaveLength(1);
  });

  it("refuses known ingredients with an empty list, and accepts 'Use catalog value'", async () => {
    signIn(ownerA, storeA);
    expect(await correctListingAttributesAction({ listingId, ingredients: { status: "known", names: [] } })).toEqual({
      error: "List at least one ingredient, or mark the ingredients as unknown",
    });
    expect((await getListingAttributesAction(listingId)).attributes?.ingredients.values).toEqual([`${RUN} groundnut`]);
    expect(await correctListingAttributesAction({ listingId, dietary: { status: "catalog", values: [] } })).toEqual({ success: true });
  });

  it("refuses an off-enum allergen or an extra field (strict schema) and changes nothing", async () => {
    signIn(ownerA, storeA);
    const bad = await correctListingAttributesAction({
      listingId,
      allergens: { status: "known", values: ["Peanuts" as "peanuts"] },
    });
    expect(bad).toEqual({ error: "Check the attributes and try again" });
    const extra = await correctListingAttributesAction({ listingId, storeId: storeB.id } as Parameters<typeof correctListingAttributesAction>[0]);
    expect(extra).toEqual({ error: "Check the attributes and try again" });
    expect((await getListingAttributesAction(listingId)).attributes?.allergens.values).toEqual(["peanuts", "sesame"]);
  });

  it("another store's owner cannot read or correct the listing", async () => {
    signIn(ownerB, storeB);
    expect(await getListingAttributesAction(listingId)).toEqual({ error: "Listing not found" });
    expect(await correctListingAttributesAction({ listingId, allergens: { status: "unknown", values: [] } }))
      .toEqual({ error: "Listing not found" });
    signIn(ownerA, storeA);
    expect((await getListingAttributesAction(listingId)).attributes?.allergens.status).toBe("known");
  });

  it("only a signed-in owner of the store gets through", async () => {
    await expect(getListingAttributesAction(listingId)).rejects.toThrow(/NEXT_REDIRECT:\/store-admin\/sign-in/);
    signIn(staff, storeA);
    await expect(correctListingAttributesAction({ listingId })).rejects.toThrow(/NEXT_REDIRECT:\/store-admin\?store=/);
    signIn(ownerA, storeB);
    await expect(getListingAttributesAction(listingId)).rejects.toThrow(/NEXT_REDIRECT/);
  });
});
