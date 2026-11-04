import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped } from "../db";
import { catalogFor } from "../storefront/catalog";
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
// Unique per run: lanes share one database and beforeEach wipes the store carts.
const storeSlug = `cart-svc-test-${process.pid}-${Date.now()}`;
// Orphans from a killed run are accepted: sweeping the prefix could delete a live lane's store.

describe.skipIf(!hasDb)("Cart service", () => {
  let rawPrisma: PrismaClient;
  let storeId: string;
  let variantId: string;
  let variant2Id: string;
  let listingId: string;
  let imageVariantId: string;
  let buyerId: string;
  let otherId: string;
  let storeBId: string;
  const buyerEmail = `buyer-${storeSlug}@example.com`;
  const otherEmail = `other-${storeSlug}@example.com`;
  const storeBSlug = `${storeSlug}-b`;

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const store = await rawPrisma.store.upsert({
      where: { slug: storeSlug },
      update: {},
      create: {
        slug: storeSlug,
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

    // "Yam" is a catalog entry with a known photo (see catalog-media.json)
    const imageListing = await scoped.listing.create({
      data: {
        storeId,
        customName: "Yam",
        price: 1200,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    const v3 = await scoped.listingVariant.create({
      data: {
        listingId: imageListing.id,
        label: "Each",
        price: 1200,
        weightG: 900,
      },
    });
    imageVariantId = v3.id;

    buyerId = `buyer-${storeSlug}`;
    otherId = `other-${storeSlug}`;
    await rawPrisma.user.create({
      data: { id: buyerId, name: "Ada Buyer", email: buyerEmail },
    });
    await rawPrisma.user.create({
      data: { id: otherId, name: "Other Buyer", email: otherEmail },
    });
    const storeB = await rawPrisma.store.create({
      data: {
        slug: storeBSlug,
        name: "Cart Service Test Store B",
        themePreset: "palm-and-shea",
      },
    });
    storeBId = storeB.id;
  });

  afterAll(async () => {
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.cartLine.deleteMany({ where: { storeId } }),
      rawPrisma.cart.deleteMany({ where: { storeId } }),
      rawPrisma.customer.deleteMany({ where: { storeId } }),
      rawPrisma.cartLine.deleteMany({ where: { storeId: storeBId } }),
      rawPrisma.cart.deleteMany({ where: { storeId: storeBId } }),
      rawPrisma.customer.deleteMany({ where: { storeId: storeBId } }),
      rawPrisma.listingVariant.deleteMany({
        where: { listing: { storeId } },
      }),
      rawPrisma.listing.deleteMany({ where: { storeId } }),
    ]);
    await rawPrisma.user.deleteMany({ where: { email: { in: [buyerEmail, otherEmail] } } });
    await rawPrisma.store.deleteMany({ where: { slug: { in: [storeSlug, storeBSlug] } } });
    await rawPrisma.$disconnect();
  });

  beforeEach(async () => {
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.cartLine.deleteMany({ where: { storeId } }),
      rawPrisma.cart.deleteMany({ where: { storeId } }),
      rawPrisma.customer.deleteMany({ where: { storeId } }),
      rawPrisma.cartLine.deleteMany({ where: { storeId: storeBId } }),
      rawPrisma.cart.deleteMany({ where: { storeId: storeBId } }),
      rawPrisma.customer.deleteMany({ where: { storeId: storeBId } }),
    ]);
  });

  describe("getOrCreateCart", () => {
    it("creates a new cart when no id given", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      expect(cartId).toMatch(/^c[a-z0-9]{24}$/);

      const rows = await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.cart.findMany({ where: { id: cartId } }),
      ]);
      const carts = rows[2];
      expect(carts).toHaveLength(1);
      expect(carts[0].storeId).toBe(storeId);
      expect(carts[0].source).toBe("manual");
      expect(carts[0].userId).toBeNull();
      expect(carts[0].customerId).toBeNull();
      const customers = await storeScoped(storeId).customer.findMany();
      expect(customers).toHaveLength(0);
    });

    it("links a new cart to a Customer for the signed-in account", async () => {
      const cartId = await getOrCreateCart(storeId, null, buyerId);
      const cart = await storeScoped(storeId).cart.findUnique({ where: { id: cartId } });
      expect(cart?.userId).toBe(buyerId);
      expect(cart?.customerId).toEqual(expect.any(String));

      const customer = await storeScoped(storeId).customer.findUnique({
        where: { id: cart!.customerId! },
      });
      expect(customer).toMatchObject({
        userId: buyerId,
        storeId,
        name: "Ada Buyer",
        email: buyerEmail,
        marketingConsent: false,
      });
    });

    it("reuses the same Customer when the account opens another cart", async () => {
      const first = await getOrCreateCart(storeId, null, buyerId);
      const second = await getOrCreateCart(storeId, null, buyerId);
      expect(second).not.toBe(first);
      const carts = await storeScoped(storeId).cart.findMany({
        where: { id: { in: [first, second] } },
      });
      expect(carts).toHaveLength(2);
      expect(carts[0].customerId).toEqual(expect.any(String));
      expect(carts[1].customerId).toBe(carts[0].customerId);
      const customers = await storeScoped(storeId).customer.findMany({
        where: { userId: buyerId },
      });
      expect(customers).toHaveLength(1);
    });

    it("links a guest cart to the account and keeps its lines", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 2);
      const linked = await getOrCreateCart(storeId, cartId, buyerId);
      expect(linked).toBe(cartId);
      const cart = await storeScoped(storeId).cart.findUnique({ where: { id: cartId } });
      expect(cart?.userId).toBe(buyerId);
      expect(cart?.customerId).toEqual(expect.any(String));
      const withLines = await getCartWithLines(storeId, cartId);
      expect(withLines?.lines).toHaveLength(1);
      expect(withLines?.lines[0].qty).toBe(2);
    });

    it("opens a new cart when the cookie cart belongs to another account", async () => {
      const theirs = await getOrCreateCart(storeId, null, otherId);
      const mine = await getOrCreateCart(storeId, theirs, buyerId);
      expect(mine).not.toBe(theirs);
      const otherCart = await storeScoped(storeId).cart.findUnique({ where: { id: theirs } });
      const myCart = await storeScoped(storeId).cart.findUnique({ where: { id: mine } });
      expect(otherCart?.userId).toBe(otherId);
      expect(myCart?.userId).toBe(buyerId);
      expect(myCart?.customerId).toEqual(expect.any(String));
      expect(myCart?.customerId).not.toBe(otherCart?.customerId);
    });

    it("keeps one Customer per account per store and hides it from the other store", async () => {
      const cartA = await getOrCreateCart(storeId, null, buyerId);
      const cartB = await getOrCreateCart(storeBId, null, buyerId);
      const rowA = await storeScoped(storeId).cart.findUnique({ where: { id: cartA } });
      const rowB = await storeScoped(storeBId).cart.findUnique({ where: { id: cartB } });
      expect(rowA?.customerId).toEqual(expect.any(String));
      expect(rowB?.customerId).toEqual(expect.any(String));
      expect(rowA?.customerId).not.toBe(rowB?.customerId);

      const visibleToB = await storeScoped(storeBId).customer.findMany({
        where: { id: rowA!.customerId! },
      });
      expect(visibleToB).toHaveLength(0);
      const visibleToA = await storeScoped(storeId).customer.findMany({
        where: { userId: buyerId },
      });
      expect(visibleToA).toHaveLength(1);
      expect(visibleToA[0].storeId).toBe(storeId);

      await expect(
        storeScoped(storeId).customer.create({
          data: {
            storeId: storeBId,
            userId: buyerId,
            name: "Cross store",
            email: buyerEmail,
          },
        }),
      ).rejects.toThrow();
    });

    it("does not create a cart when the account id is unknown", async () => {
      await expect(getOrCreateCart(storeId, null, "missing-account")).rejects.toMatchObject({
        name: "CartError",
        code: "USER_NOT_FOUND",
      });
      const carts = await storeScoped(storeId).cart.findMany();
      expect(carts).toHaveLength(0);
      const customers = await storeScoped(storeId).customer.findMany();
      expect(customers).toHaveLength(0);
    });

    it("rejects a second Customer for the same account in one store", async () => {
      await getOrCreateCart(storeId, null, buyerId);
      await expect(
        storeScoped(storeId).customer.create({
          data: {
            storeId,
            userId: buyerId,
            name: "Ada Buyer",
            email: buyerEmail,
          },
        }),
      ).rejects.toThrow(/Unique constraint/);
    });

    it("keeps a single Customer when two carts for the account start together", async () => {
      const [first, second] = await Promise.all([
        getOrCreateCart(storeId, null, buyerId),
        getOrCreateCart(storeId, null, buyerId),
      ]);
      expect(first).not.toBe(second);
      const customers = await storeScoped(storeId).customer.findMany({
        where: { userId: buyerId },
      });
      expect(customers).toHaveLength(1);
      const carts = await storeScoped(storeId).cart.findMany({
        where: { id: { in: [first, second] } },
      });
      expect(carts.map((cart) => cart.customerId)).toEqual([
        customers[0].id,
        customers[0].id,
      ]);
    });

    it("opens a fresh unlinked cart when no session holds an account cart", async () => {
      const cartId = await getOrCreateCart(storeId, null, buyerId);
      await addLine(storeId, cartId, variantId, 1);
      const original = await storeScoped(storeId).cart.findUnique({ where: { id: cartId } });
      const guestId = await getOrCreateCart(storeId, cartId, null);
      expect(guestId).not.toBe(cartId);
      const guest = await storeScoped(storeId).cart.findUnique({ where: { id: guestId } });
      expect(guest?.userId).toBeNull();
      expect(guest?.customerId).toBeNull();
      const kept = await storeScoped(storeId).cart.findUnique({ where: { id: cartId } });
      expect(kept?.userId).toBe(buyerId);
      expect(kept?.customerId).toBe(original?.customerId);
      const keptLines = await getCartWithLines(storeId, cartId);
      expect(keptLines?.lines).toHaveLength(1);
      expect(keptLines?.lines[0].qty).toBe(1);
      const customers = await storeScoped(storeId).customer.findMany();
      expect(customers).toHaveLength(1);
    });

    it("gives the losing account a new cart when two accounts claim one guest cart", async () => {
      const guestId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, guestId, variantId, 2);

      const prisma = (globalThis as unknown as { prisma: PrismaClient }).prisma;
      type FindUser = typeof prisma.user.findUnique;
      const original: FindUser = prisma.user.findUnique.bind(prisma.user);
      let seen = 0;
      let release!: () => void;
      const open = new Promise<void>((resolve) => {
        release = resolve;
      });
      const bothRead = new Promise<void>((resolve) => {
        prisma.user.findUnique = (async (args: Parameters<FindUser>[0]) => {
          const row = await original(args);
          seen += 1;
          if (seen >= 2) resolve();
          await open;
          return row;
        }) as unknown as FindUser;
      });

      try {
        const pending = Promise.all([
          getOrCreateCart(storeId, guestId, buyerId),
          getOrCreateCart(storeId, guestId, otherId),
        ]);
        await bothRead;
        release();
        const [first, second] = await pending;
        expect(first).not.toBe(second);
        expect([first, second]).toContain(guestId);
        const guest = await storeScoped(storeId).cart.findUnique({ where: { id: guestId } });
        const loserId = first === guestId ? second : first;
        const loser = await storeScoped(storeId).cart.findUnique({ where: { id: loserId } });
        expect([guest?.userId, loser?.userId].sort()).toEqual([buyerId, otherId].sort());
        expect(guest?.customerId).toEqual(expect.any(String));
        expect(loser?.customerId).toEqual(expect.any(String));
        expect(loser?.customerId).not.toBe(guest?.customerId);
        const kept = await getCartWithLines(storeId, guestId);
        expect(kept?.lines).toHaveLength(1);
        expect(kept?.lines[0].qty).toBe(2);
        const fresh = await getCartWithLines(storeId, loserId);
        expect(fresh?.lines).toHaveLength(0);
      } finally {
        prisma.user.findUnique = original;
      }
    });

    it("fills customerId when the cart already names the account", async () => {
      const cart = await storeScoped(storeId).cart.create({
        data: { storeId, userId: buyerId, source: "manual" },
      });
      const linked = await getOrCreateCart(storeId, cart.id, buyerId);
      expect(linked).toBe(cart.id);
      const row = await storeScoped(storeId).cart.findUnique({ where: { id: cart.id } });
      const customer = await storeScoped(storeId).customer.findUnique({
        where: { id: row!.customerId! },
      });
      expect(customer?.userId).toBe(buyerId);
      expect(customer?.storeId).toBe(storeId);
    });

    it("returns the same linked cart without a second Customer", async () => {
      const cartId = await getOrCreateCart(storeId, null, buyerId);
      const again = await getOrCreateCart(storeId, cartId, buyerId);
      expect(again).toBe(cartId);
      const customers = await storeScoped(storeId).customer.findMany({
        where: { userId: buyerId },
      });
      expect(customers).toHaveLength(1);
    });

    it("points an unowned cart at the account Customer", async () => {
      const guest = await storeScoped(storeId).customer.create({
        data: {
          storeId,
          name: "Guest Shopper",
          email: "guest-shopper@example.com",
          phone: "5550199",
        },
      });
      const cart = await storeScoped(storeId).cart.create({
        data: { storeId, customerId: guest.id, source: "manual" },
      });
      const linked = await getOrCreateCart(storeId, cart.id, buyerId);
      expect(linked).toBe(cart.id);
      const row = await storeScoped(storeId).cart.findUnique({ where: { id: cart.id } });
      expect(row?.userId).toBe(buyerId);
      expect(row?.customerId).not.toBe(guest.id);
      const accountCustomers = await storeScoped(storeId).customer.findMany({
        where: { userId: buyerId },
      });
      expect(accountCustomers).toHaveLength(1);
      expect(row?.customerId).toBe(accountCustomers[0].id);
    });

    it("clears the cart account when that user is removed and no Customer holds them", async () => {
      const goneId = `gone-${storeSlug}`;
      const goneEmail = `gone-${storeSlug}@example.com`;
      await rawPrisma.user.create({ data: { id: goneId, name: "Gone Buyer", email: goneEmail } });
      try {
        const cart = await storeScoped(storeId).cart.create({
          data: { storeId, userId: goneId, source: "manual" },
        });
        await rawPrisma.user.delete({ where: { id: goneId } });
        const row = await storeScoped(storeId).cart.findUnique({ where: { id: cart.id } });
        expect(row).not.toBeNull();
        expect(row?.userId).toBeNull();
      } finally {
        await rawPrisma.user.deleteMany({ where: { id: goneId } });
      }
    });

    it("rejects a cart whose account id is not a user", async () => {
      await expect(
        storeScoped(storeId).cart.create({
          data: { storeId, userId: "not-a-user", source: "manual" },
        }),
      ).rejects.toThrow(/carts_user_id_fkey/);
    });

    it("stores a note on the Customer", async () => {
      const created = await storeScoped(storeId).customer.create({
        data: {
          storeId,
          name: "Noted Shopper",
          email: "noted-shopper@example.com",
          notes: "Prefers pickup after 5",
        },
      });
      const row = await storeScoped(storeId).customer.findUnique({ where: { id: created.id } });
      expect(row?.notes).toBe("Prefers pickup after 5");
    });

    it("allows more than one guest Customer with no account in the same store", async () => {
      const scoped = storeScoped(storeId);
      const first = await scoped.customer.create({
        data: { storeId, name: "Guest One", email: "guest-one@example.com", phone: "5550101" },
      });
      const second = await scoped.customer.create({
        data: { storeId, name: "Guest Two", email: "guest-two@example.com", phone: "5550102" },
      });
      expect(first.userId).toBeNull();
      expect(second.userId).toBeNull();
      expect(first.id).not.toBe(second.id);
    });

    it("returns existing cart when valid id given", async () => {
      const id1 = await getOrCreateCart(storeId, null, null);
      const id2 = await getOrCreateCart(storeId, id1, null);
      expect(id2).toBe(id1);
    });

    it("creates new cart when invalid id given", async () => {
      const id = await getOrCreateCart(storeId, "nonexistent-id", null);
      expect(id).toMatch(/^c[a-z0-9]{24}$/);
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

    it("sums quantities across concurrent adds with no duplicate rows", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      const results = await Promise.allSettled([
        addLine(storeId, cartId, variantId, 1),
        addLine(storeId, cartId, variantId, 1),
        addLine(storeId, cartId, variantId, 1),
        addLine(storeId, cartId, variantId, 1),
      ]);
      expect(results.map((r) => r.status)).toEqual([
        "fulfilled",
        "fulfilled",
        "fulfilled",
        "fulfilled",
      ]);

      const rows = await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.cartLine.findMany({ where: { cartId, variantId } }),
      ]);
      const lines = rows[2];
      expect(lines).toHaveLength(1);
      expect(lines[0].qty).toBe(4);
    });

    it("never exceeds maxPerOrder under concurrent adds", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      // maxPerOrder is 5: seven concurrent +1 adds -> exactly five succeed
      const results = await Promise.allSettled(
        Array.from({ length: 7 }, () => addLine(storeId, cartId, variantId, 1)),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      expect(rejected).toHaveLength(2);
      for (const r of rejected) {
        expect((r.reason as CartError).code).toBe("MAX_PER_ORDER");
      }
      const cart = await getCartWithLines(storeId, cartId);
      expect(cart!.lines).toHaveLength(1);
      expect(cart!.lines[0].qty).toBe(5);
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
        where: { slug: `${storeSlug}-other` },
        update: {},
        create: {
          slug: `${storeSlug}-other`,
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
      await rawPrisma.store.deleteMany({ where: { slug: `${storeSlug}-other` } });
    });
  });

  describe("updateLineQty", () => {
    it("updates quantity on an existing line", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 1);
      const cart = await getCartWithLines(storeId, cartId);
      await updateLineQty(storeId, cartId, cart!.lines[0].id, 3);
      const updated = await getCartWithLines(storeId, cartId);
      expect(updated!.lines[0].qty).toBe(3);
    });

    it("removes line when qty is 0", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 2);
      const cart = await getCartWithLines(storeId, cartId);
      await updateLineQty(storeId, cartId, cart!.lines[0].id, 0);
      const updated = await getCartWithLines(storeId, cartId);
      expect(updated!.lines).toHaveLength(0);
    });

    it("enforces maxPerOrder", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 1);
      const cart = await getCartWithLines(storeId, cartId);
      await expect(
        updateLineQty(storeId, cartId, cart!.lines[0].id, 10),
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
        cartId,
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
        cartId,
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
        updateLineSwapRule(storeId, cartId, cart!.lines[0].id, "named_substitute", null),
      ).rejects.toThrow(CartError);
    });

    it("clears substituteVariantId when switching back to exact_only", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 1);
      const cart = await getCartWithLines(storeId, cartId);
      await updateLineSwapRule(
        storeId,
        cartId,
        cart!.lines[0].id,
        "named_substitute",
        variant2Id,
      );
      await updateLineSwapRule(
        storeId,
        cartId,
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
      await removeLine(storeId, cartId, cart!.lines[0].id);
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
      await addLine(storeId, cartId, imageVariantId, 1);
      const cart = await getCartWithLines(storeId, cartId);
      // Literal on purpose: the test must fail if the catalog mapping changes
      expect(catalogFor("Yam")?.imageUrl).toBe(
        "/images/products/yam-white-puna.webp",
      );
      expect(cart!.lines[0].imageUrl).toBe("/images/products/yam-white-puna.webp");
    });

    it("leaves imageUrl undefined when the catalog has no photo", async () => {
      const cartId = await getOrCreateCart(storeId, null, null);
      await addLine(storeId, cartId, variantId, 1);
      const cart = await getCartWithLines(storeId, cartId);
      expect(cart!.lines[0].imageUrl).toBeUndefined();
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
