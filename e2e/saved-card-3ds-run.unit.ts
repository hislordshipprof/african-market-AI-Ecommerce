import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveDirectUrl } from "../src/lib/env";
import { cleanupSavedCard3dsRun } from "./saved-card-3ds-run";

const hasDb = Boolean(process.env.DATABASE_URL);
const run = `t311-cleanup-${Date.now().toString(36)}`;

describe.skipIf(!hasDb)("real-Stripe 3DS spec cleanup", () => {
  const prisma = hasDb ? new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) }) : (null as never);
  const userIds: string[] = [];
  let storeId = "";
  let otherVariantId = "";
  let orderNumber = 0;

  // The test's own store stands in for the shared sandbox store: the spec's run and another shopper both use it.
  beforeAll(async () => {
    const store = await prisma.store.create({ data: { slug: run, name: "Cleanup lane", stripeAccountId: `acct_${run.replace(/-/g, "")}` } });
    storeId = store.id;
    const other = await asAdmin(async (tx) => {
      const listing = await tx.listing.create({ data: { storeId, customName: `Other ${run}`, price: 900, stockMode: "unlimited" } });
      return tx.listingVariant.create({ data: { listingId: listing.id, label: "Each", price: 900, weightG: 200 } });
    });
    otherVariantId = other.id;
  });

  afterAll(async () => {
    await asAdmin(async (tx) => {
      await tx.order.deleteMany({ where: { storeId } });
      await tx.cart.deleteMany({ where: { storeId } });
      await tx.customer.deleteMany({ where: { storeId } });
      await tx.listingVariant.deleteMany({ where: { listing: { storeId } } });
      await tx.listing.deleteMany({ where: { storeId } });
    });
    await prisma.store.delete({ where: { id: storeId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  function asAdmin<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return work(tx);
    });
  }

  async function user(suffix: string) {
    const id = `user-${run}-${suffix}`;
    userIds.push(id);
    return prisma.user.create({ data: { id, name: "Ada", email: `${id}@test.example` } });
  }

  /** What the spec leaves behind when it fails after placing its first order: a listing, an order, a held cart, a saved-card customer. */
  async function specRun(suffix: string) {
    const shopper = await user(suffix);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.user_id', ${shopper.id}, true)`;
      await tx.platformCustomerProfile.create({ data: { userId: shopper.id, stripeCustomerId: `cus_${run}_${suffix}` } });
    });
    return asAdmin(async (tx) => {
      const listing = await tx.listing.create({ data: { storeId, customName: `Three DS ${run} ${suffix}`, price: 4000, stockMode: "unlimited" } });
      const variant = await tx.listingVariant.create({ data: { listingId: listing.id, label: "Each", price: 4000, weightG: 200 } });
      const customer = await tx.customer.create({ data: { storeId, userId: shopper.id, email: shopper.email, name: "Ada" } });
      const order = await tx.order.create({
        data: {
          storeId, number: ++orderNumber, customerId: customer.id, subtotalCents: 4000, bufferCents: 400, totalAuthorizedCents: 4400,
          paymentIntentId: `pi_${run}_${suffix}_order`,
          lines: { create: { listingVariantId: variant.id, qtyOrdered: 1, unitPriceCents: 4000 } },
        },
      });
      const cart = await tx.cart.create({
        data: { storeId, userId: shopper.id, customerId: customer.id, paymentIntentId: `pi_${run}_${suffix}_cart`, lines: { create: { storeId, variantId: variant.id, qty: 1 } } },
      });
      return { email: shopper.email, listingId: listing.id, userId: shopper.id, orderId: order.id, cartId: cart.id, customerId: customer.id };
    });
  }

  function recorder() {
    const cancelled: string[] = [];
    const deleted: string[] = [];
    return {
      cancelled,
      deleted,
      stripe: {
        cancelHold: async (id: string) => void cancelled.push(id),
        deleteCustomer: async (id: string) => void deleted.push(id),
      },
    };
  }

  it("leaves another shopper's empty cart, customer and order in the shared store untouched", async () => {
    const shopper = await user("other");
    const others = await asAdmin(async (tx) => {
      const customer = await tx.customer.create({ data: { storeId, userId: shopper.id, email: shopper.email, name: "Bola" } });
      const order = await tx.order.create({
        data: {
          storeId, number: ++orderNumber, customerId: customer.id, subtotalCents: 900, bufferCents: 90, totalAuthorizedCents: 990,
          paymentIntentId: `pi_${run}_other_order`,
          lines: { create: { listingVariantId: otherVariantId, qtyOrdered: 1, unitPriceCents: 900 } },
        },
      });
      // An emptied cart still holds its saved address and the intent the orphan-hold sweep tracks.
      const cart = await tx.cart.create({
        data: { storeId, userId: shopper.id, customerId: customer.id, paymentIntentId: `pi_${run}_other_cart`, deliveryLine1: "1 Unrelated Way", deliveryZip: "77017" },
      });
      return { customerId: customer.id, orderId: order.id, cartId: cart.id };
    });
    const mine = await specRun("a");

    await cleanupSavedCard3dsRun(prisma, { storeId, email: mine.email, listingId: mine.listingId }, recorder().stripe);

    const left = await asAdmin(async (tx) => ({
      cart: await tx.cart.findUnique({ where: { id: others.cartId }, select: { paymentIntentId: true, deliveryLine1: true } }),
      customer: await tx.customer.count({ where: { id: others.customerId } }),
      order: await tx.order.count({ where: { id: others.orderId } }),
    }));
    expect(left).toEqual({
      cart: { paymentIntentId: `pi_${run}_other_cart`, deliveryLine1: "1 Unrelated Way" },
      customer: 1,
      order: 1,
    });
  });

  it("after a failure past the first order, releases the run's holds and removes every row it made", async () => {
    const mine = await specRun("b");
    const sandbox = recorder();

    // The spec records no intents when it fails before its final assertions.
    await cleanupSavedCard3dsRun(prisma, { storeId, email: mine.email, listingId: mine.listingId }, sandbox.stripe);

    expect(sandbox.cancelled.sort()).toEqual([`pi_${run}_b_cart`, `pi_${run}_b_order`]);
    expect(sandbox.deleted).toEqual([`cus_${run}_b`]);
    const left = await asAdmin(async (tx) => ({
      orders: await tx.order.count({ where: { id: mine.orderId } }),
      carts: await tx.cart.count({ where: { id: mine.cartId } }),
      customers: await tx.customer.count({ where: { id: mine.customerId } }),
      listings: await tx.listing.count({ where: { id: mine.listingId } }),
    }));
    expect(left).toEqual({ orders: 0, carts: 0, customers: 0, listings: 0 });
    expect(await prisma.user.count({ where: { id: mine.userId } })).toBe(0);
  });
});
