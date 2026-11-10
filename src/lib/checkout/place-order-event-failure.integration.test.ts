import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { findOrphanedAuthorizedOrders, storeScoped } from "../db";
import type { Contact } from "../customer-flow/contracts";

const retrieve = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());

vi.mock("../stripe/provider", () => ({
  getStripeClient: () => ({ paymentIntents: { retrieve } }),
}));

vi.mock("../inngest/client", () => ({
  inngest: { send },
}));

import { computeQuote, placeOrder } from "./service";

const hasDb = !!process.env.DATABASE_URL;
const CONTACT: Contact = { name: "Ada Buyer", phone: "+15551234567", email: "orphan@t236.test" };

describe.skipIf(!hasDb)("placeOrder event failure (real send, mocked transport)", () => {
  let raw: PrismaClient;
  const storeIds: string[] = [];

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    send.mockRejectedValue(new Error("transport down"));
  }, 30_000);

  afterAll(async () => {
    if (raw && storeIds.length > 0) {
      await raw.$transaction([
        raw.$executeRaw`SET LOCAL ROLE app_user`,
        raw.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        raw.cartLine.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.cart.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.orderLine.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.order.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.customer.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.listingVariant.deleteMany({ where: { listing: { storeId: { in: storeIds } } } }),
        raw.listing.deleteMany({ where: { storeId: { in: storeIds } } }),
      ]);
      await raw.store.deleteMany({ where: { id: { in: storeIds } } });
    }
    await raw?.$disconnect();
  }, 30_000);

  it("failed real send preserves order and orphan recovery marker", async () => {
    const store = await raw.store.create({
      data: {
        slug: `t236-orphan-${crypto.randomUUID().slice(0, 8)}`,
        name: "Orphan",
        themePreset: "palm-and-shea",
        stripeAccountId: `acct_orphan_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        stripeOnboardingStatus: "complete",
        pickupEnabled: true,
      },
    });
    storeIds.push(store.id);
    const listing = await storeScoped(store.id).listing.create({
      data: {
        storeId: store.id,
        customName: "Orphan pack",
        price: 500,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    const variant = await storeScoped(store.id).listingVariant.create({
      data: { listingId: listing.id, label: "V", price: 500, weightG: 100 },
    });
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const cart = await storeScoped(store.id).cart.create({
      data: { storeId: store.id, paymentIntentId },
    });
    await storeScoped(store.id).cartLine.create({
      data: { storeId: store.id, cartId: cart.id, variantId: variant.id, qty: 1, swapRule: "exact_only" },
    });
    const hold = computeQuote(0, [{ price: 500, qty: 1, maxPerOrder: null }], CONTACT, "pickup").holdCents;
    retrieve.mockResolvedValue({
      status: "requires_capture",
      amount: hold,
      on_behalf_of: store.stripeAccountId,
      transfer_data: { destination: store.stripeAccountId },
      metadata: { store_id: store.id },
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await placeOrder(store.id, 0, cart.id, CONTACT, "pickup", null, null, paymentIntentId);
    warn.mockRestore();

    expect(result.token).toBeTruthy();
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    const order = await storeScoped(store.id).order.findUnique({ where: { id: result.token } });
    expect(order?.status).toBe("AUTHORIZED");
    expect(order?.inngestEventSentAt).toBeNull();
    expect(order?.paymentIntentId).toBe(paymentIntentId);

    await storeScoped(store.id).order.update({
      where: { id: result.token },
      data: { createdAt: new Date(Date.now() - 120_000) },
    });
    const orphans = await findOrphanedAuthorizedOrders();
    expect(orphans).toContainEqual({ id: result.token, storeId: store.id });
  }, 20_000);
});
