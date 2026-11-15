import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped, storeScopedTransaction } from "../db";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("Cart and CartLine RLS isolation", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;
  let variantAId: string;
  let variantBId: string;
  let cartAId: string;
  let cartBId: string;

  beforeAll(async () => {
    rawPrisma = testPrismaClient();
    await rawPrisma.$connect();

    const storeA = await rawPrisma.store.upsert({
      where: { slug: "rls-cart-a" },
      update: {},
      create: {
        slug: "rls-cart-a",
        name: "Cart Store A",
        themePreset: "palm-and-shea",
      },
    });
    storeAId = storeA.id;

    const storeB = await rawPrisma.store.upsert({
      where: { slug: "rls-cart-b" },
      update: {},
      create: {
        slug: "rls-cart-b",
        name: "Cart Store B",
        themePreset: "lagoon-and-coral",
      },
    });
    storeBId = storeB.id;

    const scopedA = storeScoped(storeAId);
    const listingA = await scopedA.listing.create({
      data: {
        storeId: storeAId,
        customName: "Cart Test Product A",
        price: 500,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    const vA = await scopedA.listingVariant.create({
      data: {
        listingId: listingA.id,
        label: "250g",
        price: 500,
        weightG: 250,
      },
    });
    variantAId = vA.id;

    const scopedB = storeScoped(storeBId);
    const listingB = await scopedB.listing.create({
      data: {
        storeId: storeBId,
        customName: "Cart Test Product B",
        price: 800,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    const vB = await scopedB.listingVariant.create({
      data: {
        listingId: listingB.id,
        label: "500g",
        price: 800,
        weightG: 500,
      },
    });
    variantBId = vB.id;

    const cartA = await scopedA.cart.create({
      data: { storeId: storeAId, source: "manual" },
    });
    cartAId = cartA.id;

    await scopedA.cartLine.create({
      data: {
        storeId: storeAId,
        cartId: cartAId,
        variantId: variantAId,
        qty: 2,
        swapRule: "exact_only",
      },
    });

    const cartB = await scopedB.cart.create({
      data: { storeId: storeBId, source: "manual" },
    });
    cartBId = cartB.id;

    await scopedB.cartLine.create({
      data: {
        storeId: storeBId,
        cartId: cartBId,
        variantId: variantBId,
        qty: 1,
        swapRule: "store_suggests",
      },
    });
  });

  afterAll(async () => {
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.cartLine.deleteMany({
        where: { storeId: { in: [storeAId, storeBId] } },
      }),
      rawPrisma.cart.deleteMany({
        where: { storeId: { in: [storeAId, storeBId] } },
      }),
      rawPrisma.listingVariant.deleteMany({
        where: {
          listing: { storeId: { in: [storeAId, storeBId] } },
        },
      }),
      rawPrisma.listing.deleteMany({
        where: { storeId: { in: [storeAId, storeBId] } },
      }),
    ]);
    await rawPrisma.store.deleteMany({
      where: { slug: { in: ["rls-cart-a", "rls-cart-b"] } },
    });
    await rawPrisma.$disconnect();
  });

  it("store A can read its own carts", async () => {
    const scoped = storeScoped(storeAId);
    const carts = await scoped.cart.findMany();
    expect(carts.length).toBeGreaterThanOrEqual(1);
    expect(carts.every((c) => c.storeId === storeAId)).toBe(true);
  });

  it("store B cannot read store A carts", async () => {
    const scoped = storeScoped(storeBId);
    const carts = await scoped.cart.findMany();
    expect(carts.every((c) => c.storeId === storeBId)).toBe(true);
    expect(carts.find((c) => c.id === cartAId)).toBeUndefined();
  });

  it("store A can read its own cart lines", async () => {
    const scoped = storeScoped(storeAId);
    const lines = await scoped.cartLine.findMany();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.every((l) => l.storeId === storeAId)).toBe(true);
  });

  it("store B cannot read store A cart lines", async () => {
    const scoped = storeScoped(storeBId);
    const lines = await scoped.cartLine.findMany();
    expect(lines.every((l) => l.storeId === storeBId)).toBe(true);
  });

  it("cross-store cart insert is rejected by RLS", async () => {
    const scoped = storeScoped(storeAId);
    await expect(
      scoped.cart.create({
        data: { storeId: storeBId, source: "manual" },
      }),
    ).rejects.toThrow();
  });

  it("cross-store cart line insert is rejected by RLS", async () => {
    const scoped = storeScoped(storeAId);
    await expect(
      scoped.cartLine.create({
        data: {
          storeId: storeBId,
          cartId: cartBId,
          variantId: variantBId,
          qty: 1,
          swapRule: "exact_only",
        },
      }),
    ).rejects.toThrow();
  });

  it("store A cannot update or delete store B cart lines", async () => {
    const before = await storeScoped(storeBId).cartLine.findFirstOrThrow({
      where: { cartId: cartBId },
    });
    expect(before.qty).toBe(1);
    const scopedA = storeScoped(storeAId);
    await expect(
      scopedA.cartLine.update({ where: { id: before.id }, data: { qty: 9 } }),
    ).rejects.toMatchObject({ code: "P2025" });
    expect(
      (await scopedA.cartLine.updateMany({ where: { id: before.id }, data: { qty: 9 } })).count,
    ).toBe(0);
    expect((await scopedA.cartLine.deleteMany({ where: { id: before.id } })).count).toBe(0);
    const after = await storeScoped(storeBId).cartLine.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(after.qty).toBe(1);
    const owned = await storeScoped(storeAId).cartLine.findFirstOrThrow({
      where: { cartId: cartAId },
    });
    expect(owned.qty).toBe(2);
  });

  it("storeScopedTransaction enforces isolation for cart operations", async () => {
    await storeScopedTransaction(storeAId, async (tx) => {
      const carts = await tx.cart.findMany();
      expect(carts.every((c) => c.storeId === storeAId)).toBe(true);
      const lines = await tx.cartLine.findMany();
      expect(lines.every((l) => l.storeId === storeAId)).toBe(true);
    });
  });
});
