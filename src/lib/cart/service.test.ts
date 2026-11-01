import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped } from "../db";
import {
  getOrCreateCart,
  addLine,
  updateLineQty,
  updateLineSwapRule,
  removeLine,
  clearAllLines,
  getCartWithLines,
  checkMinimumOrder,
  CartError,
} from "./service";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("Cart service", () => {
  let rawPrisma: PrismaClient;
  let storeId: string;
  let variantId: string;
  let variant2Id: string;
  let listingId: string;

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const store = await rawPrisma.store.upsert({
      where: { slug: "cart-svc-test" },
      update: {},
      create: {
        slug: "cart-svc-test",
        name: "Cart Service Test Store",
        themePreset: "palm-and-shea",
        minimumOrderCents: 2000,
      },
    });
    storeId = store.id;

    const scoped = storeScoped(storeId);
    const listing = await scoped.listing.create({
      data: {
        storeId,
        customName: "Jollof Rice Mix",
        price: 1500,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
        maxPerOrder: 5,
      },
    });
    listingId = listing.id;

    const v1 = await scoped.listingVariant.create({
      data: {
        listingId: listing.id,
        label: "500g",
        price: 1500,
        weightG: 500,
      },
    });
    variantId = v1.id;

    const v2 = await scoped.listingVariant.create({
      data: {
        listingId: listing.id,
        label: "1kg",
        price: 2500,
        weightG: 1000,
      },
    });
    variant2Id = v2.id;
  });

  afterAll(async () => {
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.cartLine.deleteMany({ where: { storeId } }),
      rawPrisma.cart.deleteMany({ where: { storeId } }),
      rawPrisma.listingVariant.deleteMany({
        where: { listing: { storeId } },
      }),
      rawPrisma.listing.deleteMany({ where: { storeId } }),
    ]);
    await rawPrisma.store.deleteMany({ where: { slug: "cart-svc-test" } });
    await rawPrisma.$disconnect();
  });

  beforeEach(async () => {
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.cartLine.deleteMany({ where: { storeId } }),
      rawPrisma.cart.deleteMany({ where: { storeId } }),
    ]);
  });

  describe("getOrCreateCart", () => {
    it("creates a new cart when no id given", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      expect(cartId).toBeTruthy();
    });

    it("returns existing cart when valid id given", async () => {
      const id1 = await getOrCreateCart(storeId, null, null);
      const id2 = await getOrCreateCart(storeId, id1, null);
      expect(id2).toBe(id1);
    });

    it("creates new cart when invalid id given", async () => {
      const id = await getOrCreateCart(storeId, "nonexistent-id", null);
      expect(id).toBeTruthy();
      expect(id).not.toBe("nonexistent-id");
    });
  });

  describe("addLine", () => {
    it("adds a line to the cart", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 2);
      const cart = await getCartWithLines(storeId, cartId);
      expect(cart!.lines).toHaveLength(1);
      expect(cart!.lines[0].variantId).toBe(variantId);
      expect(cart!.lines[0].qty).toBe(2);
    });

    it("increments qty when variant already in cart", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 2);
      await addLine(storeId, cartId, variantId, 1);
      const cart = await getCartWithLines(storeId, cartId);
      expect(cart!.lines).toHaveLength(1);
      expect(cart!.lines[0].qty).toBe(3);
    });

    it("enforces maxPerOrder limit", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 4);
      await expect(
        addLine(storeId, cartId, variantId, 2),
      ).rejects.toThrow(CartError);
      try {
        await addLine(storeId, cartId, variantId, 2);
      } catch (e) {
        expect(e).toBeInstanceOf(CartError);
        expect((e as CartError).code).toBe("MAX_PER_ORDER");
      }
    });

    it("rejects variant from another store", async () => {
      const otherStore = await rawPrisma.store.upsert({
        where: { slug: "cart-svc-other" },
        update: {},
        create: {
          slug: "cart-svc-other",
          name: "Other Store",
          themePreset: "palm-and-shea",
        },
      });
      const scoped2 = storeScoped(otherStore.id);
      const otherListing = await scoped2.listing.create({
        data: {
          storeId: otherStore.id,
          customName: "Other Product",
          price: 999,
          stockMode: "unlimited",
          frozen: false,
          perishable: false,
        },
      });
      const otherVariant = await scoped2.listingVariant.create({
        data: {
          listingId: otherListing.id,
          label: "Each",
          price: 999,
          weightG: 200,
        },
      });

      const cartId = await getOrCreateCart(storeId, null, null);
      await expect(
        addLine(storeId, cartId, otherVariant.id, 1),
      ).rejects.toThrow(CartError);

      // cleanup
      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.listingVariant.deleteMany({
          where: { listing: { storeId: otherStore.id } },
        }),
        rawPrisma.listing.deleteMany({ where: { storeId: otherStore.id } }),
      ]);
      await rawPrisma.store.deleteMany({ where: { slug: "cart-svc-other" } });
    });
  });

  describe("updateLineQty", () => {
    it("updates quantity on an existing line", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 1);
      const cart = await getCartWithLines(storeId, cartId);
      await updateLineQty(storeId, cart!.lines[0].id, 3);
      const updated = await getCartWithLines(storeId, cartId);
      expect(updated!.lines[0].qty).toBe(3);
    });

    it("removes line when qty is 0", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 2);
      const cart = await getCartWithLines(storeId, cartId);
      await updateLineQty(storeId, cart!.lines[0].id, 0);
      const updated = await getCartWithLines(storeId, cartId);
      expect(updated!.lines).toHaveLength(0);
    });

    it("enforces maxPerOrder", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 1);
      const cart = await getCartWithLines(storeId, cartId);
      await expect(
        updateLineQty(storeId, cart!.lines[0].id, 10),
      ).rejects.toThrow(CartError);
    });
  });

  describe("updateLineSwapRule", () => {
    it("sets swap rule to store_suggests", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 1);
      const cart = await getCartWithLines(storeId, cartId);
      await updateLineSwapRule(
        storeId,
        cart!.lines[0].id,
        "store_suggests",
        null,
      );
      const updated = await getCartWithLines(storeId, cartId);
      expect(updated!.lines[0].swapRule).toBe("store_suggests");
    });

    it("sets named_substitute with valid substitute", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 1);
      const cart = await getCartWithLines(storeId, cartId);
      await updateLineSwapRule(
        storeId,
        cart!.lines[0].id,
        "named_substitute",
        variant2Id,
      );
      const updated = await getCartWithLines(storeId, cartId);
      expect(updated!.lines[0].swapRule).toBe("named_substitute");
      expect(updated!.lines[0].substituteVariantId).toBe(variant2Id);
    });

    it("rejects named_substitute without substituteVariantId", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 1);
      const cart = await getCartWithLines(storeId, cartId);
      await expect(
        updateLineSwapRule(storeId, cart!.lines[0].id, "named_substitute", null),
      ).rejects.toThrow(CartError);
    });

    it("clears substituteVariantId when switching back to exact_only", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 1);
      const cart = await getCartWithLines(storeId, cartId);
      await updateLineSwapRule(
        storeId,
        cart!.lines[0].id,
        "named_substitute",
        variant2Id,
      );
      await updateLineSwapRule(
        storeId,
        cart!.lines[0].id,
        "exact_only",
        null,
      );
      const updated = await getCartWithLines(storeId, cartId);
      expect(updated!.lines[0].swapRule).toBe("exact_only");
      expect(updated!.lines[0].substituteVariantId).toBeNull();
    });
  });

  describe("removeLine", () => {
    it("removes a cart line", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 1);
      const cart = await getCartWithLines(storeId, cartId);
      await removeLine(storeId, cart!.lines[0].id);
      const updated = await getCartWithLines(storeId, cartId);
      expect(updated!.lines).toHaveLength(0);
    });
  });

  describe("clearAllLines", () => {
    it("removes all lines from a cart", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 2);
      await addLine(storeId, cartId, variant2Id, 1);
      const cart = await getCartWithLines(storeId, cartId);
      expect(cart!.lines).toHaveLength(2);
      await clearAllLines(storeId, cartId);
      const updated = await getCartWithLines(storeId, cartId);
      expect(updated!.lines).toHaveLength(0);
    });
  });

  describe("getCartWithLines", () => {
    it("returns null for nonexistent cart", async () => {
      const result = await getCartWithLines(storeId, "nonexistent");
      expect(result).toBeNull();
    });

    it("returns cart with lines and computed subtotal", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 2);
      await addLine(storeId, cartId, variant2Id, 1);
      const cart = await getCartWithLines(storeId, cartId);
      expect(cart).not.toBeNull();
      expect(cart!.lines).toHaveLength(2);
      expect(cart!.subtotalCents).toBe(2 * 1500 + 1 * 2500);
    });

    it("includes imageUrl from catalog", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 1);
      const cart = await getCartWithLines(storeId, cartId);
      expect(cart!.lines[0]).toHaveProperty("imageUrl");
    });
  });

  describe("checkMinimumOrder", () => {
    it("returns not allowed when below minimum", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 1);
      const result = await checkMinimumOrder(storeId, cartId);
      expect(result.allowed).toBe(false);
      expect(result.minimumCents).toBe(2000);
      expect(result.currentCents).toBe(1500);
    });

    it("returns allowed when at or above minimum", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 2);
      const result = await checkMinimumOrder(storeId, cartId);
      expect(result.allowed).toBe(true);
      expect(result.currentCents).toBe(3000);
    });
  });
});
