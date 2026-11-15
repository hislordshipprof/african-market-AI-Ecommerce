import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { countedListing, placeOrder } from "../order/stock-ledger-test-helpers";
import { directoryOrderCount } from "./directory-orders";

const hasDb = !!process.env.DATABASE_URL;

// #454: an order placed with the directory cookie is stamped, and the store sees only its own count.
describe.skipIf(!hasDb)("directory attribution on orders", () => {
  const run = `d6-${Date.now()}`;
  let raw: PrismaClient;
  const stores = { a: "", b: "" };
  const variants = { a: "", b: "" };

  beforeAll(async () => {
    raw = testPrismaClient();
    for (const key of ["a", "b"] as const) {
      const store = await raw.store.create({ data: { slug: `${run}-${key}`, name: `D6 ${key}`, themePreset: "palm-and-shea" } });
      stores[key] = store.id;
      variants[key] = (await countedListing(store.id, 50)).variantId;
    }
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      const ids = Object.values(stores).filter(Boolean);
      await tx.stockEvent.deleteMany({ where: { storeId: { in: ids } } });
      await tx.order.deleteMany({ where: { storeId: { in: ids } } });
      await tx.customer.deleteMany({ where: { storeId: { in: ids } } });
      await tx.cart.deleteMany({ where: { storeId: { in: ids } } });
      await tx.listingVariant.deleteMany({ where: { listing: { storeId: { in: ids } } } });
      await tx.listing.deleteMany({ where: { storeId: { in: ids } } });
      await tx.store.deleteMany({ where: { id: { in: ids } } });
    });
    await raw.$disconnect();
  });

  async function sourceOf(storeId: string, orderId: string) {
    const order = await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: orderId } });
    return order.acquisitionSource;
  }

  it("leaves the column null when no ref was present", async () => {
    const { orderId } = await placeOrder(stores.a, [{ variantId: variants.a, qty: 1 }]);
    expect(await sourceOf(stores.a, orderId)).toBeNull();
  });

  it("stamps directory on an order placed with the directory cookie", async () => {
    const { orderId } = await placeOrder(stores.a, [{ variantId: variants.a, qty: 1 }], "directory");
    expect(await sourceOf(stores.a, orderId)).toBe("directory");
  });

  it("counts only this store's directory orders", async () => {
    await placeOrder(stores.a, [{ variantId: variants.a, qty: 1 }], "directory");
    await placeOrder(stores.b, [{ variantId: variants.b, qty: 1 }], "directory");
    await placeOrder(stores.b, [{ variantId: variants.b, qty: 1 }], "directory");
    await placeOrder(stores.b, [{ variantId: variants.b, qty: 1 }]);
    expect(await directoryOrderCount(stores.a)).toBe(2);
    expect(await directoryOrderCount(stores.b)).toBe(2);
  });
});
