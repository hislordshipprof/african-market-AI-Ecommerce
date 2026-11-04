import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped } from "../db";
import type { Contact } from "../customer-flow/contracts";

const retrieve = vi.hoisted(() => vi.fn());

vi.mock("../stripe/provider", () => ({
  getStripeClient: () => ({ paymentIntents: { retrieve } }),
}));

vi.mock("../inngest/send", () => ({
  sendOrderAuthorized: vi.fn().mockResolvedValue(undefined),
}));

import { sendOrderAuthorized } from "../inngest/send";
import {
  checkoutTestHooks,
  computeQuote,
  placeOrder,
  recordAuthorizedOrder,
} from "./service";

const hasDb = !!process.env.DATABASE_URL;
const CONTACT: Contact = { name: "Ada Buyer", phone: "+15551234567", email: "ada@t236-orch.test" };

describe.skipIf(!hasDb)("placeOrder orchestration (lane DB, strict Stripe double)", () => {
  let raw: PrismaClient;
  const storeIds: string[] = [];

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    await raw.$connect();
  }, 30_000);

  afterEach(() => {
    checkoutTestHooks.afterMissedOrderLookup = null;
    retrieve.mockReset();
    vi.mocked(sendOrderAuthorized).mockClear();
  });

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

  async function makeStore(label: string) {
    const store = await raw.store.create({
      data: {
        slug: `t236-orch-${label}-${crypto.randomUUID().slice(0, 8)}`,
        name: `Orch ${label}`,
        themePreset: "palm-and-shea",
        stripeAccountId: `acct_orch_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        stripeOnboardingStatus: "complete",
        pickupEnabled: true,
      },
    });
    storeIds.push(store.id);
    return store;
  }

  async function makeVariant(storeId: string, price = 500) {
    const listing = await storeScoped(storeId).listing.create({
      data: {
        storeId,
        customName: "Orch pack",
        price,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    return storeScoped(storeId).listingVariant.create({
      data: { listingId: listing.id, label: "V", price, weightG: 100 },
    });
  }

  function holdFor(price: number, qty: number) {
    return computeQuote(0, [{ price, qty, maxPerOrder: null }], CONTACT, "pickup").holdCents;
  }

  function paymentIntent(opts: {
    status?: string;
    amount: number;
    destination: string;
    onBehalfOf: string;
    storeId: string;
  }) {
    return {
      status: opts.status ?? "requires_capture",
      amount: opts.amount,
      on_behalf_of: opts.onBehalfOf,
      transfer_data: { destination: opts.destination },
      metadata: { store_id: opts.storeId },
    };
  }

  async function counts(storeId: string) {
    const scoped = storeScoped(storeId);
    const [orders, customers] = await Promise.all([
      scoped.order.count(),
      scoped.customer.count(),
    ]);
    return { orders, customers };
  }

  it("duplicate checkout resumes after winner clears cart", async () => {
    const store = await makeStore("resume");
    const variant = await makeVariant(store.id);
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const cart = await storeScoped(store.id).cart.create({
      data: { storeId: store.id, paymentIntentId },
    });
    await storeScoped(store.id).cartLine.create({
      data: { storeId: store.id, cartId: cart.id, variantId: variant.id, qty: 1, swapRule: "exact_only" },
    });
    retrieve.mockResolvedValue(paymentIntent({
      amount: holdFor(500, 1),
      destination: store.stripeAccountId!,
      onBehalfOf: store.stripeAccountId!,
      storeId: store.id,
    }));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    checkoutTestHooks.afterMissedOrderLookup = async () => {
      entered = true;
      checkoutTestHooks.afterMissedOrderLookup = null;
      await gate;
    };

    const loser = placeOrder(store.id, 0, cart.id, CONTACT, "pickup", null, null, paymentIntentId);
    const start = Date.now();
    while (!entered && Date.now() - start < 10_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(entered).toBe(true);

    const winner = await placeOrder(store.id, 0, cart.id, CONTACT, "pickup", null, null, paymentIntentId);
    release();
    const resumed = await loser;

    expect(resumed.token).toBe(winner.token);
    expect(await counts(store.id)).toEqual({ orders: 1, customers: 1 });
    expect(sendOrderAuthorized).toHaveBeenCalledTimes(1);
    expect(sendOrderAuthorized).toHaveBeenCalledWith(store.id, winner.token);
    const emptied = await storeScoped(store.id).cart.findUnique({
      where: { id: cart.id },
      include: { lines: true },
    });
    expect(emptied?.paymentIntentId).toBeNull();
    expect(emptied?.lines).toEqual([]);
  }, 20_000);

  it("foreign unrecorded payment intent is rejected before persistence", async () => {
    const store = await makeStore("fields");
    const other = await makeStore("fields-other");
    const variant = await makeVariant(store.id);
    const cases = [
      {
        label: "destination",
        destination: other.stripeAccountId!,
        onBehalfOf: store.stripeAccountId!,
        metaStore: store.id,
        message: /destination does not match store/,
      },
      {
        label: "on_behalf_of",
        destination: store.stripeAccountId!,
        onBehalfOf: other.stripeAccountId!,
        metaStore: store.id,
        message: /on_behalf_of does not match store/,
      },
      {
        label: "metadata",
        destination: store.stripeAccountId!,
        onBehalfOf: store.stripeAccountId!,
        metaStore: other.id,
        message: /store_id metadata does not match/,
      },
    ];
    for (const field of cases) {
      const paymentIntentId = `pi_${field.label}_${crypto.randomUUID()}`;
      const cart = await storeScoped(store.id).cart.create({
        data: { storeId: store.id, paymentIntentId },
      });
      await storeScoped(store.id).cartLine.create({
        data: { storeId: store.id, cartId: cart.id, variantId: variant.id, qty: 1, swapRule: "exact_only" },
      });
      retrieve.mockResolvedValue(paymentIntent({
        amount: holdFor(500, 1),
        destination: field.destination,
        onBehalfOf: field.onBehalfOf,
        storeId: field.metaStore,
      }));
      await expect(
        placeOrder(store.id, 0, cart.id, CONTACT, "pickup", null, null, paymentIntentId),
      ).rejects.toThrow(field.message);
    }
    expect(await counts(store.id)).toEqual({ orders: 0, customers: 0 });
    expect(sendOrderAuthorized).not.toHaveBeenCalled();

    const ownerVariant = await makeVariant(other.id);
    const taken = `pi_taken_${crypto.randomUUID()}`;
    const ownerCart = await storeScoped(other.id).cart.create({
      data: { storeId: other.id, paymentIntentId: taken },
    });
    await storeScoped(other.id).cartLine.create({
      data: { storeId: other.id, cartId: ownerCart.id, variantId: ownerVariant.id, qty: 1, swapRule: "exact_only" },
    });
    const quote = computeQuote(0, [{ price: 500, qty: 1, maxPerOrder: null }], CONTACT, "pickup");
    const recorded = await recordAuthorizedOrder(other.id, {
      cartId: ownerCart.id,
      contact: CONTACT,
      fulfillment: "pickup",
      pickupSlot: null,
      notes: null,
      paymentIntentId: taken,
      quote,
      lines: [{
        variantId: ownerVariant.id,
        qty: 1,
        price: 500,
        swapRule: "exact_only",
        substituteVariantId: null,
      }],
    });
    const bidderCart = await storeScoped(store.id).cart.create({
      data: { storeId: store.id, paymentIntentId: taken },
    });
    await storeScoped(store.id).cartLine.create({
      data: { storeId: store.id, cartId: bidderCart.id, variantId: variant.id, qty: 1, swapRule: "exact_only" },
    });
    retrieve.mockResolvedValue(paymentIntent({
      amount: holdFor(500, 1),
      destination: store.stripeAccountId!,
      onBehalfOf: store.stripeAccountId!,
      storeId: store.id,
    }));
    const rejected = placeOrder(store.id, 0, bidderCart.id, CONTACT, "pickup", null, null, taken);
    await expect(rejected).rejects.toThrow(/^PaymentIntent is already recorded$/);
    await expect(rejected).rejects.not.toThrow(recorded.orderId);
    expect(await counts(store.id)).toEqual({ orders: 0, customers: 0 });
  }, 20_000);

  it("foreign primary and substitute variants cannot become order lines", async () => {
    const store = await makeStore("own");
    const other = await makeStore("foreign-variant");
    const own = await makeVariant(store.id);
    const foreign = await makeVariant(other.id);
    const paymentIntentId = `pi_sub_${crypto.randomUUID()}`;
    const cart = await storeScoped(store.id).cart.create({
      data: { storeId: store.id, paymentIntentId },
    });
    await storeScoped(store.id).cartLine.create({
      data: {
        storeId: store.id,
        cartId: cart.id,
        variantId: own.id,
        qty: 1,
        swapRule: "named_substitute",
        substituteVariantId: foreign.id,
      },
    });
    retrieve.mockResolvedValue(paymentIntent({
      amount: holdFor(500, 1),
      destination: store.stripeAccountId!,
      onBehalfOf: store.stripeAccountId!,
      storeId: store.id,
    }));
    await expect(
      placeOrder(store.id, 0, cart.id, CONTACT, "pickup", null, null, paymentIntentId),
    ).rejects.toThrow(`Substitute variant ${foreign.id} does not belong to this store`);

    const primaryCart = await storeScoped(store.id).cart.create({
      data: { storeId: store.id, paymentIntentId: `pi_primary_${crypto.randomUUID()}` },
    });
    const quote = computeQuote(0, [{ price: 500, qty: 1, maxPerOrder: null }], CONTACT, "pickup");
    await expect(recordAuthorizedOrder(store.id, {
      cartId: primaryCart.id,
      contact: { ...CONTACT, email: "primary@t236-orch.test" },
      fulfillment: "pickup",
      pickupSlot: null,
      notes: null,
      paymentIntentId: primaryCart.paymentIntentId!,
      quote,
      lines: [{
        variantId: foreign.id,
        qty: 1,
        price: 500,
        swapRule: "exact_only",
        substituteVariantId: null,
      }],
    })).rejects.toThrow(`Variant ${foreign.id} does not belong to this store`);

    expect(await counts(store.id)).toEqual({ orders: 0, customers: 0 });
    expect(await storeScoped(other.id).order.count()).toBe(0);
    expect(sendOrderAuthorized).not.toHaveBeenCalled();
  });

  it("invalid status and hold mismatch never persist or send", async () => {
    const store = await makeStore("status");
    const variant = await makeVariant(store.id);
    const hold = holdFor(500, 1);
    const cases = [
      { status: "canceled", amount: hold, message: /canceled/ },
      { status: "succeeded", amount: hold, message: /succeeded/ },
      { status: "requires_payment_method", amount: hold, message: /requires_payment_method/ },
      { status: "requires_capture", amount: hold + 1, message: /does not match quote hold/ },
      { status: "requires_capture", amount: hold - 1, message: /does not match quote hold/ },
    ];
    for (const field of cases) {
      const paymentIntentId = `pi_${field.status}_${field.amount}_${crypto.randomUUID()}`;
      const cart = await storeScoped(store.id).cart.create({
        data: { storeId: store.id, paymentIntentId },
      });
      await storeScoped(store.id).cartLine.create({
        data: { storeId: store.id, cartId: cart.id, variantId: variant.id, qty: 1, swapRule: "exact_only" },
      });
      retrieve.mockResolvedValue(paymentIntent({
        status: field.status,
        amount: field.amount,
        destination: store.stripeAccountId!,
        onBehalfOf: store.stripeAccountId!,
        storeId: store.id,
      }));
      await expect(
        placeOrder(store.id, 0, cart.id, CONTACT, "pickup", null, null, paymentIntentId),
      ).rejects.toThrow(field.message);
      const kept = await storeScoped(store.id).cart.findUnique({ where: { id: cart.id } });
      expect(kept?.paymentIntentId).toBe(paymentIntentId);
    }
    expect(await counts(store.id)).toEqual({ orders: 0, customers: 0 });
    expect(sendOrderAuthorized).not.toHaveBeenCalled();
  });
});
