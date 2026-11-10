import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { addLine } from "../cart/service";
import { healthQueryRaw, storeScoped } from "../db";
import type { Contact } from "../customer-flow/contracts";

const { retrieve, cancel, paymentIntents } = vi.hoisted(() => {
  const paymentIntents = new Map<string, Record<string, unknown>>();
  function usesConnectedAccount(arg: unknown): boolean {
    return Boolean(
      arg &&
      typeof arg === "object" &&
      "stripeAccount" in arg &&
      (arg as { stripeAccount?: unknown }).stripeAccount,
    );
  }
  const retrieve = vi.fn(async (id: string, params?: unknown, options?: unknown) => {
    if (usesConnectedAccount(params) || usesConnectedAccount(options)) {
      throw new Error(`No such payment_intent: '${id}'`);
    }
    const fixture = paymentIntents.get(id);
    if (!fixture) throw new Error(`No such payment_intent: '${id}'`);
    return fixture;
  });
  const cancel = vi.fn(async (id: string) => {
    const fixture = paymentIntents.get(id);
    if (!fixture) throw new Error(`No such payment_intent: '${id}'`);
    if (fixture.status === "canceled") {
      throw new Error("You cannot cancel this PaymentIntent because it has a status of canceled");
    }
    fixture.status = "canceled";
    return fixture;
  });
  return { retrieve, cancel, paymentIntents };
});

vi.mock("../stripe/provider", () => ({
  getStripeClient: () => ({ paymentIntents: { retrieve, cancel } }),
}));

vi.mock("../inngest/send", () => ({
  sendOrderAuthorized: vi.fn().mockResolvedValue(undefined),
}));

import { sendOrderAuthorized } from "../inngest/send";
import { setAddressProvider } from "../address/provider";
import {
  BasketChangedError,
  checkoutTestHooks,
  computeQuote,
  placeOrder,
  recordAuthorizedOrder,
} from "./service";

const hasDb = !!process.env.DATABASE_URL;
const CONTACT: Contact = { name: "Ada Buyer", phone: "+15551234567", email: "ada@t236-orch.test" };

describe("strict Stripe retrieve double", () => {
  afterEach(() => {
    retrieve.mockClear();
    paymentIntents.clear();
  });

  it("rejects an unknown id and any connected-account request", async () => {
    paymentIntents.set("pi_known", { id: "pi_known", status: "requires_capture" });
    await expect(retrieve("pi_missing")).rejects.toThrow("No such payment_intent: 'pi_missing'");
    await expect(retrieve("pi_known", {}, { stripeAccount: "acct_connected" })).rejects.toThrow(
      "No such payment_intent: 'pi_known'",
    );
    await expect(retrieve("pi_known", { stripeAccount: "acct_connected" })).rejects.toThrow(
      "No such payment_intent: 'pi_known'",
    );
    await expect(retrieve("pi_known")).resolves.toMatchObject({ id: "pi_known", status: "requires_capture" });
  });
});

describe.skipIf(!hasDb)("placeOrder orchestration (lane DB, strict Stripe double)", () => {
  let raw: PrismaClient;
  const storeIds: string[] = [];

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    const login = (await healthQueryRaw`SELECT current_user, session_user`) as Array<{
      current_user: string;
      session_user: string;
    }>;
    if (login[0]?.current_user !== "app_runtime" || login[0]?.session_user !== "app_runtime") {
      throw new Error("placeOrder orchestration must run as app_runtime");
    }
  }, 30_000);

  afterEach(() => {
    checkoutTestHooks.afterMissedOrderLookup = null;
    checkoutTestHooks.aroundCartRead = null;
    checkoutTestHooks.afterPostReadLookupMiss = null;
    retrieve.mockClear();
    paymentIntents.clear();
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

  async function persistedOrder(storeId: string, orderId: string) {
    const order = await storeScoped(storeId).order.findUnique({
      where: { id: orderId },
      include: { customer: true, lines: { orderBy: { id: "asc" } } },
    });
    if (!order) throw new Error("expected the winner order to stay readable");
    return {
      customer: {
        id: order.customer.id,
        name: order.customer.name,
        email: order.customer.email,
        phone: order.customer.phone,
        updatedAt: order.customer.updatedAt.toISOString(),
      },
      order: {
        id: order.id,
        number: order.number,
        status: order.status,
        customerId: order.customerId,
        paymentIntentId: order.paymentIntentId,
        subtotalCents: order.subtotalCents,
        bufferCents: order.bufferCents,
        totalAuthorizedCents: order.totalAuthorizedCents,
        fulfillment: order.fulfillment,
        notes: order.notes,
        updatedAt: order.updatedAt.toISOString(),
      },
      lines: order.lines.map((line) => ({
        id: line.id,
        listingVariantId: line.listingVariantId,
        qtyOrdered: line.qtyOrdered,
        unitPriceCents: line.unitPriceCents,
        swapRule: line.swapRule,
        updatedAt: line.updatedAt.toISOString(),
      })),
    };
  }

  async function cartSnapshot(storeId: string, cartId: string) {
    const cart = await storeScoped(storeId).cart.findUnique({
      where: { id: cartId },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    return {
      paymentIntentId: cart?.paymentIntentId ?? null,
      lines: (cart?.lines ?? []).map((line) => ({
        id: line.id,
        variantId: line.variantId,
        qty: line.qty,
      })),
    };
  }

  function watch<T>(promise: Promise<T>) {
    const settled = promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    return { promise, settled };
  }

  function pauseOn(hook: "afterMissedOrderLookup" | "afterPostReadLookupMiss") {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let entered = false;
    let released = false;
    const pause = async () => {
      entered = true;
      checkoutTestHooks[hook] = null;
      await gate;
    };
    checkoutTestHooks[hook] = pause;
    return {
      release() {
        if (!released) {
          released = true;
          releaseGate();
        }
      },
      async wait() {
        const start = Date.now();
        while (!entered && Date.now() - start < 10_000) {
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        if (!entered) throw new Error(`checkout did not reach ${hook}`);
      },
    };
  }

  function pauseAroundCartRead() {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let entered = false;
    let released = false;
    checkoutTestHooks.aroundCartRead = async (read) => {
      entered = true;
      checkoutTestHooks.aroundCartRead = null;
      await gate;
      return read();
    };
    return {
      release() {
        if (!released) {
          released = true;
          releaseGate();
        }
      },
      async wait() {
        const start = Date.now();
        while (!entered && Date.now() - start < 10_000) {
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        if (!entered) throw new Error("checkout did not reach the cart read");
      },
    };
  }

  async function seedPricedCart(label: string, price = 500, qty = 1) {
    const store = await makeStore(label);
    const variant = await makeVariant(store.id, price);
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const cart = await storeScoped(store.id).cart.create({
      data: { storeId: store.id, paymentIntentId },
    });
    await storeScoped(store.id).cartLine.create({
      data: { storeId: store.id, cartId: cart.id, variantId: variant.id, qty, swapRule: "exact_only" },
    });
    const amount = holdFor(price, qty);
    paymentIntents.set(
      paymentIntentId,
      paymentIntent({
        amount,
        destination: store.stripeAccountId!,
        onBehalfOf: store.stripeAccountId!,
        storeId: store.id,
      }),
    );
    return { store, variant, cart, paymentIntentId, amount };
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
    paymentIntents.set(paymentIntentId, paymentIntent({
      amount: holdFor(500, 1),
      destination: store.stripeAccountId!,
      onBehalfOf: store.stripeAccountId!,
      storeId: store.id,
    }));

    const pause = pauseOn("afterMissedOrderLookup");
    const loser = watch(placeOrder(store.id, 0, cart.id, CONTACT, "pickup", null, null, paymentIntentId));
    try {
      await pause.wait();
      const winner = await placeOrder(store.id, 0, cart.id, CONTACT, "pickup", null, null, paymentIntentId);
      pause.release();
      const resumed = await loser.promise;
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
    } finally {
      pause.release();
      await Promise.allSettled([loser.promise]);
    }
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
      paymentIntents.set(paymentIntentId, paymentIntent({
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
    paymentIntents.set(taken, paymentIntent({
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
    paymentIntents.set(paymentIntentId, paymentIntent({
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
    })).rejects.toThrow(/This order was already placed/);

    expect(await counts(store.id)).toEqual({ orders: 0, customers: 0 });
    expect(await storeScoped(other.id).order.count()).toBe(0);
    expect(sendOrderAuthorized).not.toHaveBeenCalled();
  });

  it("invalid status and hold mismatch never persist or send", async () => {
    const store = await makeStore("status");
    const variant = await makeVariant(store.id);
    const hold = holdFor(500, 1);
    const cases = [
      { status: "canceled", amount: hold, message: /Your basket changed/ },
      { status: "succeeded", amount: hold, message: /succeeded/ },
      { status: "requires_payment_method", amount: hold, message: /requires_payment_method/ },
      { status: "requires_capture", amount: hold + 1, message: /Your basket changed/ },
      { status: "requires_capture", amount: hold - 1, message: /Your basket changed/ },
    ];
    for (const field of cases) {
      const paymentIntentId = `pi_${field.status}_${field.amount}_${crypto.randomUUID()}`;
      const cart = await storeScoped(store.id).cart.create({
        data: { storeId: store.id, paymentIntentId },
      });
      await storeScoped(store.id).cartLine.create({
        data: { storeId: store.id, cartId: cart.id, variantId: variant.id, qty: 1, swapRule: "exact_only" },
      });
      paymentIntents.set(paymentIntentId, paymentIntent({
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
      expect(kept?.paymentIntentId).toBe(
        field.status === "requires_capture" ? null : paymentIntentId,
      );
    }
    expect(await counts(store.id)).toEqual({ orders: 0, customers: 0 });
    expect(sendOrderAuthorized).not.toHaveBeenCalled();
  });

  it("duplicate checkout returns the winner's order whatever the refilled cart holds", async () => {
    const rows: Array<{
      label: string;
      minimum: number;
      refill: (storeId: string, cartId: string, variantId: string) => Promise<void>;
      nextIntent?: boolean;
    }> = [
      {
        label: "different amount",
        minimum: 0,
        refill: (storeId, cartId, variantId) => addLine(storeId, cartId, variantId, 2),
      },
      {
        label: "same amount",
        minimum: 0,
        refill: (storeId, cartId, variantId) => addLine(storeId, cartId, variantId, 1),
      },
      {
        label: "below minimum",
        minimum: 500,
        refill: async (storeId, cartId) => {
          const cheap = await makeVariant(storeId, 100);
          await addLine(storeId, cartId, cheap.id, 1);
        },
      },
      {
        label: "buffer capped at $20",
        minimum: 0,
        refill: async (storeId, cartId) => {
          const bulk = await makeVariant(storeId, 20_000);
          await addLine(storeId, cartId, bulk.id, 1);
        },
      },
      {
        label: "second payment intent",
        minimum: 0,
        nextIntent: true,
        refill: (storeId, cartId, variantId) => addLine(storeId, cartId, variantId, 2),
      },
    ];

    for (const row of rows) {
      vi.mocked(sendOrderAuthorized).mockClear();
      retrieve.mockClear();
      const seeded = await seedPricedCart(row.label.replace(/\s+/g, "-"), 500, 1);
      expect(seeded.amount).toBe(550);
      const pause = pauseOn("afterMissedOrderLookup");
      const loser = watch(
        placeOrder(
          seeded.store.id,
          row.minimum,
          seeded.cart.id,
          CONTACT,
          "pickup",
          null,
          null,
          seeded.paymentIntentId,
        ),
      );
      try {
        await pause.wait();
        const winner = await placeOrder(
          seeded.store.id,
          row.minimum,
          seeded.cart.id,
          CONTACT,
          "pickup",
          null,
          null,
          seeded.paymentIntentId,
        );
        const beforeRows = await persistedOrder(seeded.store.id, winner.token);
        await row.refill(seeded.store.id, seeded.cart.id, seeded.variant.id);
        let nextIntent: string | null = null;
        if (row.nextIntent) {
          nextIntent = `pi_next_${crypto.randomUUID()}`;
          await storeScoped(seeded.store.id).cart.update({
            where: { id: seeded.cart.id },
            data: { paymentIntentId: nextIntent },
          });
        }
        const beforeCart = await cartSnapshot(seeded.store.id, seeded.cart.id);
        if (row.label === "different amount") expect(beforeCart.lines.map((line) => line.qty)).toEqual([2]);
        pause.release();
        const resumed = await loser.promise;
        expect(resumed.token, row.label).toBe(winner.token);
        expect(await counts(seeded.store.id), row.label).toEqual({ orders: 1, customers: 1 });
        expect(sendOrderAuthorized, row.label).toHaveBeenCalledTimes(1);
        expect(sendOrderAuthorized).toHaveBeenCalledWith(seeded.store.id, winner.token);
        expect(await persistedOrder(seeded.store.id, winner.token), row.label).toEqual(beforeRows);
        expect(await cartSnapshot(seeded.store.id, seeded.cart.id), row.label).toEqual(beforeCart);
        expect(retrieve.mock.calls.map((call) => call[0]), row.label).toEqual([
          seeded.paymentIntentId,
          seeded.paymentIntentId,
        ]);
        if (nextIntent) {
          expect(retrieve.mock.calls.some((call) => call[0] === nextIntent)).toBe(false);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`${row.label}: ${message}`);
      } finally {
        pause.release();
        await loser.settled;
      }
    }
  }, 30_000);

  it("winner commits while duplicate cart read is pending", async () => {
    const seeded = await seedPricedCart("during-read");
    const pause = pauseAroundCartRead();
    const loser = watch(
      placeOrder(seeded.store.id, 0, seeded.cart.id, CONTACT, "pickup", null, null, seeded.paymentIntentId),
    );
    try {
      await pause.wait();
      const winner = await placeOrder(
        seeded.store.id,
        0,
        seeded.cart.id,
        CONTACT,
        "pickup",
        null,
        null,
        seeded.paymentIntentId,
      );
      const beforeRows = await persistedOrder(seeded.store.id, winner.token);
      await addLine(seeded.store.id, seeded.cart.id, seeded.variant.id, 2);
      const beforeCart = await cartSnapshot(seeded.store.id, seeded.cart.id);
      expect(beforeCart.lines.map((line) => line.qty)).toEqual([2]);
      pause.release();
      const resumed = await loser.promise;
      expect(resumed.token).toBe(winner.token);
      expect(await persistedOrder(seeded.store.id, winner.token)).toEqual(beforeRows);
      expect(await cartSnapshot(seeded.store.id, seeded.cart.id)).toEqual(beforeCart);
      expect(sendOrderAuthorized).toHaveBeenCalledTimes(1);
      expect(sendOrderAuthorized).toHaveBeenCalledWith(seeded.store.id, winner.token);
      expect(retrieve.mock.calls.map((call) => call[0])).toEqual([
        seeded.paymentIntentId,
        seeded.paymentIntentId,
      ]);
    } finally {
      pause.release();
      await loser.settled;
    }
  }, 20_000);

  it("duplicate checkout that read the cart before the winner committed returns the winner's order", async () => {
    const seeded = await seedPricedCart("before-commit");
    const pause = pauseOn("afterPostReadLookupMiss");
    const loser = watch(
      placeOrder(seeded.store.id, 0, seeded.cart.id, CONTACT, "pickup", null, null, seeded.paymentIntentId),
    );
    try {
      await pause.wait();
      const winner = await placeOrder(
        seeded.store.id,
        0,
        seeded.cart.id,
        CONTACT,
        "pickup",
        null,
        null,
        seeded.paymentIntentId,
      );
      const beforeRows = await persistedOrder(seeded.store.id, winner.token);
      const beforeCart = await cartSnapshot(seeded.store.id, seeded.cart.id);
      expect(beforeCart.lines).toEqual([]);
      pause.release();
      const resumed = await loser.promise;
      expect(resumed.token).toBe(winner.token);
      expect(await persistedOrder(seeded.store.id, winner.token)).toEqual(beforeRows);
      expect(await cartSnapshot(seeded.store.id, seeded.cart.id)).toEqual(beforeCart);
      expect(sendOrderAuthorized).toHaveBeenCalledTimes(1);
      expect(sendOrderAuthorized).toHaveBeenCalledWith(seeded.store.id, winner.token);
      expect(retrieve.mock.calls.map((call) => call[0])).toEqual([
        seeded.paymentIntentId,
        seeded.paymentIntentId,
      ]);
    } finally {
      pause.release();
      await loser.settled;
    }
  }, 20_000);

  it("a new order still checks the PaymentIntent amount against the hold", async () => {
    const store = await makeStore("amount");
    const variant = await makeVariant(store.id, 555);
    const quote = computeQuote(0, [{ price: 555, qty: 1, maxPerOrder: null }], CONTACT, "pickup");
    expect(quote.bufferCents).toBe(56);
    expect(quote.holdCents).toBe(611);

    for (const amount of [610, 612]) {
      const paymentIntentId = `pi_${amount}_${crypto.randomUUID()}`;
      const cart = await storeScoped(store.id).cart.create({
        data: { storeId: store.id, paymentIntentId },
      });
      await storeScoped(store.id).cartLine.create({
        data: { storeId: store.id, cartId: cart.id, variantId: variant.id, qty: 1, swapRule: "exact_only" },
      });
      paymentIntents.set(
        paymentIntentId,
        paymentIntent({
          amount,
          destination: store.stripeAccountId!,
          onBehalfOf: store.stripeAccountId!,
          storeId: store.id,
        }),
      );
      await expect(
        placeOrder(store.id, 0, cart.id, CONTACT, "pickup", null, null, paymentIntentId),
      ).rejects.toThrow(/Your basket changed/);
      const kept = await storeScoped(store.id).cart.findUnique({ where: { id: cart.id } });
      expect(kept?.paymentIntentId).toBeNull();
    }
    expect(await counts(store.id)).toEqual({ orders: 0, customers: 0 });
    expect(sendOrderAuthorized).not.toHaveBeenCalled();

    const paymentIntentId = `pi_611_${crypto.randomUUID()}`;
    const cart = await storeScoped(store.id).cart.create({
      data: { storeId: store.id, paymentIntentId },
    });
    await storeScoped(store.id).cartLine.create({
      data: { storeId: store.id, cartId: cart.id, variantId: variant.id, qty: 1, swapRule: "exact_only" },
    });
    paymentIntents.set(
      paymentIntentId,
      paymentIntent({
        amount: 611,
        destination: store.stripeAccountId!,
        onBehalfOf: store.stripeAccountId!,
        storeId: store.id,
      }),
    );
    const placed = await placeOrder(store.id, 0, cart.id, CONTACT, "pickup", null, null, paymentIntentId);
    const order = await storeScoped(store.id).order.findUnique({ where: { id: placed.token } });
    expect(order?.totalAuthorizedCents).toBe(611);
    expect(order?.paymentIntentId).toBe(paymentIntentId);
    expect(order?.status).toBe("AUTHORIZED");
    expect(await counts(store.id)).toEqual({ orders: 1, customers: 1 });
    expect(sendOrderAuthorized).toHaveBeenCalledTimes(1);
    expect(sendOrderAuthorized).toHaveBeenCalledWith(store.id, placed.token);
  }, 20_000);

  it("a replay is still rejected when the PaymentIntent is no longer requires_capture", async () => {
    const seeded = await seedPricedCart("status-replay");
    const winner = await placeOrder(
      seeded.store.id,
      0,
      seeded.cart.id,
      CONTACT,
      "pickup",
      null,
      null,
      seeded.paymentIntentId,
    );
    const beforeRows = await persistedOrder(seeded.store.id, winner.token);
    vi.mocked(sendOrderAuthorized).mockClear();
    for (const status of ["canceled", "succeeded"]) {
      paymentIntents.set(
        seeded.paymentIntentId,
        paymentIntent({
          status,
          amount: seeded.amount,
          destination: seeded.store.stripeAccountId!,
          onBehalfOf: seeded.store.stripeAccountId!,
          storeId: seeded.store.id,
        }),
      );
      const rejected = placeOrder(
        seeded.store.id,
        0,
        seeded.cart.id,
        CONTACT,
        "pickup",
        null,
        null,
        seeded.paymentIntentId,
      );
      await expect(rejected).rejects.toThrow(new RegExp(status));
      await expect(rejected).rejects.not.toThrow(winner.token);
    }
    expect(await persistedOrder(seeded.store.id, winner.token)).toEqual(beforeRows);
    expect(sendOrderAuthorized).not.toHaveBeenCalled();
    expect(await counts(seeded.store.id)).toEqual({ orders: 1, customers: 1 });
  }, 20_000);

  it("recorded replay still validates each provenance field", async () => {
    const store = await makeStore("prov");
    const other = await makeStore("prov-other");
    const seeded = await seedPricedCart("prov-cart");
    // seedPricedCart creates its own store. Use that store as the owner.
    const owner = seeded.store;
    const winner = await placeOrder(owner.id, 0, seeded.cart.id, CONTACT, "pickup", null, null, seeded.paymentIntentId);
    const beforeRows = await persistedOrder(owner.id, winner.token);
    vi.mocked(sendOrderAuthorized).mockClear();
    const cases: Array<{
      label: string;
      destination?: string;
      onBehalfOf?: string;
      meta?: string;
      omitTransfer?: boolean;
      omitBehalf?: boolean;
      omitMeta?: boolean;
      message: RegExp;
    }> = [
      {
        label: "destination",
        destination: other.stripeAccountId!,
        onBehalfOf: owner.stripeAccountId!,
        meta: owner.id,
        message: /destination does not match store/,
      },
      {
        label: "missing destination",
        onBehalfOf: owner.stripeAccountId!,
        meta: owner.id,
        omitTransfer: true,
        message: /destination does not match store/,
      },
      {
        label: "on_behalf_of",
        destination: owner.stripeAccountId!,
        onBehalfOf: other.stripeAccountId!,
        meta: owner.id,
        message: /on_behalf_of does not match store/,
      },
      {
        label: "missing on_behalf_of",
        destination: owner.stripeAccountId!,
        meta: owner.id,
        omitBehalf: true,
        message: /on_behalf_of does not match store/,
      },
      {
        label: "metadata",
        destination: owner.stripeAccountId!,
        onBehalfOf: owner.stripeAccountId!,
        meta: other.id,
        message: /store_id metadata does not match/,
      },
      {
        label: "missing metadata",
        destination: owner.stripeAccountId!,
        onBehalfOf: owner.stripeAccountId!,
        omitMeta: true,
        message: /store_id metadata does not match/,
      },
    ];
    for (const field of cases) {
      paymentIntents.set(seeded.paymentIntentId, {
        status: "requires_capture",
        amount: seeded.amount,
        ...(field.omitBehalf ? {} : { on_behalf_of: field.onBehalfOf }),
        ...(field.omitTransfer ? {} : { transfer_data: { destination: field.destination } }),
        metadata: field.omitMeta ? {} : { store_id: field.meta },
      });
      const rejected = placeOrder(owner.id, 0, seeded.cart.id, CONTACT, "pickup", null, null, seeded.paymentIntentId);
      await expect(rejected, field.label).rejects.toThrow(field.message);
      await expect(rejected, field.label).rejects.not.toThrow(winner.token);
    }
    await expect(
      placeOrder(owner.id, 0, seeded.cart.id, CONTACT, "courier", null, null, seeded.paymentIntentId),
    ).rejects.toThrow(/Only pickup fulfillment is supported/);
    expect(await persistedOrder(owner.id, winner.token)).toEqual(beforeRows);
    expect(sendOrderAuthorized).not.toHaveBeenCalled();
    expect(await counts(owner.id)).toEqual({ orders: 1, customers: 1 });
    expect(await counts(store.id)).toEqual({ orders: 0, customers: 0 });
  }, 20_000);

  const HOUSTON = { lat: 29.693857800118, lng: -95.266257879374 };
  const MAIN_ST = { lat: 29.73846459154, lng: -95.379640065998 };

  async function seedDeliveryCart(label: string, price = 4000) {
    const store = await makeStore(label);
    await raw.store.update({
      where: { id: store.id },
      data: {
        storeDeliveryEnabled: true,
        storeDeliveryFeeCents: 500,
        deliveryRadiusMi: 8,
        addressLine1: "8400 Park Place Blvd",
        city: "Houston",
        state: "TX",
        zip: "77017",
        lat: HOUSTON.lat,
        lng: HOUSTON.lng,
      },
    });
    const variant = await makeVariant(store.id, price);
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const cart = await storeScoped(store.id).cart.create({
      data: {
        storeId: store.id,
        paymentIntentId,
        deliveryLine1: "3700 MAIN ST",
        deliveryCity: "HOUSTON",
        deliveryState: "TX",
        deliveryZip: "77002",
        deliveryLat: MAIN_ST.lat,
        deliveryLng: MAIN_ST.lng,
        leaveAtDoor: true,
      },
    });
    await storeScoped(store.id).cartLine.create({
      data: { storeId: store.id, cartId: cart.id, variantId: variant.id, qty: 1, swapRule: "exact_only" },
    });
    const quote = computeQuote(0, [{ price, qty: 1, maxPerOrder: null }], CONTACT, "store-delivery", {
      enabled: true,
      feeCents: 500,
      radiusMi: 8,
      hasCoordinates: true,
      confirmed: { withinRadius: true },
      leaveAtDoor: true,
    });
    paymentIntents.set(paymentIntentId, paymentIntent({
      amount: quote.holdCents,
      destination: store.stripeAccountId!,
      onBehalfOf: store.stripeAccountId!,
      storeId: store.id,
    }));
    return { store, variant, cart, paymentIntentId, quote };
  }

  it("a store delivery order records the fee, address and leave-at-door", async () => {
    const seeded = await seedDeliveryCart("deliver");
    const placed = await placeOrder(
      seeded.store.id, 0, seeded.cart.id, CONTACT, "store-delivery", null, null, seeded.paymentIntentId,
    );
    const order = await storeScoped(seeded.store.id).order.findUnique({ where: { id: placed.token } });
    expect(order?.fulfillment).toBe("store-delivery");
    expect(order?.deliveryFeeCents).toBe(500);
    expect(order?.deliveryLine1).toBe("3700 MAIN ST");
    expect(order?.deliveryCity).toBe("HOUSTON");
    expect(order?.deliveryState).toBe("TX");
    expect(order?.deliveryZip).toBe("77002");
    expect(order?.leaveAtDoor).toBe(true);
    expect(order?.deliveryLat).toBeCloseTo(MAIN_ST.lat, 4);
    expect(order?.deliveryLng).toBeCloseTo(MAIN_ST.lng, 4);
    expect(order?.deliveryDistanceMi).toBeGreaterThan(0);
    expect(order?.totalCents).toBe(4500);
    expect(order?.totalAuthorizedCents).toBe(4900);
  });

  it("placement refuses leave at door when the cart has a frozen item", async () => {
    const seeded = await seedDeliveryCart("frozen");
    await storeScoped(seeded.store.id).listing.update({
      where: { id: seeded.variant.listingId },
      data: { frozen: true },
    });
    await expect(
      placeOrder(seeded.store.id, 0, seeded.cart.id, CONTACT, "store-delivery", null, null, seeded.paymentIntentId),
    ).rejects.toBeInstanceOf(BasketChangedError);
    expect(await storeScoped(seeded.store.id).order.count()).toBe(0);
    expect(paymentIntents.get(seeded.paymentIntentId)?.status).toBe("canceled");
  });

  it("a store delivery fee raised after the hold refuses placement", async () => {
    const seeded = await seedDeliveryCart("fee");
    await raw.store.update({
      where: { id: seeded.store.id },
      data: { storeDeliveryFeeCents: 800 },
    });
    await expect(recordAuthorizedOrder(seeded.store.id, {
      cartId: seeded.cart.id,
      contact: CONTACT,
      fulfillment: "store-delivery",
      pickupSlot: null,
      notes: null,
      paymentIntentId: seeded.paymentIntentId,
      quote: seeded.quote,
      paymentAmount: seeded.quote.holdCents,
      minimumOrderCents: 0,
      lines: [{
        variantId: seeded.variant.id,
        qty: 1,
        price: 4000,
        swapRule: "exact_only",
        substituteVariantId: null,
      }],
    })).rejects.toBeInstanceOf(BasketChangedError);
    expect(await storeScoped(seeded.store.id).order.count()).toBe(0);
  });

  it("turning store delivery off after the hold refuses the locked recompute", async () => {
    const seeded = await seedDeliveryCart("off");
    await raw.store.update({
      where: { id: seeded.store.id },
      data: { storeDeliveryEnabled: false },
    });
    await expect(recordAuthorizedOrder(seeded.store.id, {
      cartId: seeded.cart.id,
      contact: CONTACT,
      fulfillment: "store-delivery",
      pickupSlot: null,
      notes: null,
      paymentIntentId: seeded.paymentIntentId,
      quote: seeded.quote,
      paymentAmount: seeded.quote.holdCents,
      minimumOrderCents: 0,
      lines: [{
        variantId: seeded.variant.id,
        qty: 1,
        price: 4000,
        swapRule: "exact_only",
        substituteVariantId: null,
      }],
    })).rejects.toBeInstanceOf(BasketChangedError);
    expect(await storeScoped(seeded.store.id).order.count()).toBe(0);
  });

  it("a store delivery placement refused for the radius releases the hold", async () => {
    const seeded = await seedDeliveryCart("radius");
    await raw.store.update({
      where: { id: seeded.store.id },
      data: { deliveryRadiusMi: 1 },
    });
    await expect(
      placeOrder(seeded.store.id, 0, seeded.cart.id, CONTACT, "store-delivery", null, null, seeded.paymentIntentId),
    ).rejects.toBeInstanceOf(BasketChangedError);
    expect(paymentIntents.get(seeded.paymentIntentId)?.status).toBe("canceled");
    expect(await storeScoped(seeded.store.id).order.count()).toBe(0);
  });

  it("placement after payment makes no address-service call", async () => {
    setAddressProvider({
      suggest: async () => { throw new Error("photon"); },
      locate: async () => { throw new Error("census"); },
    });
    const seeded = await seedDeliveryCart("cached");
    const first = await placeOrder(
      seeded.store.id, 0, seeded.cart.id, CONTACT, "store-delivery", null, null, seeded.paymentIntentId,
    );
    const second = await placeOrder(
      seeded.store.id, 0, seeded.cart.id, CONTACT, "store-delivery", null, null, seeded.paymentIntentId,
    );
    expect(second.token).toBe(first.token);
    setAddressProvider(null);
  });

  it("store B never receives store A's order for a PaymentIntent A recorded", async () => {
    const seeded = await seedPricedCart("owner-pi");
    const storeB = await makeStore("bidder-pi");
    const winner = await placeOrder(
      seeded.store.id,
      0,
      seeded.cart.id,
      CONTACT,
      "pickup",
      null,
      null,
      seeded.paymentIntentId,
    );
    const beforeRows = await persistedOrder(seeded.store.id, winner.token);
    const cartB = await storeScoped(storeB.id).cart.create({ data: { storeId: storeB.id } });
    await storeScoped(storeB.id).cartLine.create({
      data: {
        storeId: storeB.id,
        cartId: cartB.id,
        variantId: (await makeVariant(storeB.id)).id,
        qty: 2,
        swapRule: "exact_only",
      },
    });
    vi.mocked(sendOrderAuthorized).mockClear();
    const rejected = placeOrder(
      storeB.id,
      0,
      cartB.id,
      CONTACT,
      "pickup",
      null,
      null,
      seeded.paymentIntentId,
    );
    await expect(rejected).rejects.toThrow(/destination does not match store/);
    await expect(rejected).rejects.not.toThrow(winner.token);
    expect(await counts(storeB.id)).toEqual({ orders: 0, customers: 0 });
    expect(await persistedOrder(seeded.store.id, winner.token)).toEqual(beforeRows);
    expect(sendOrderAuthorized).not.toHaveBeenCalled();
  }, 20_000);

  it("post-read lookup cannot reveal another store's newly committed order", async () => {
    // Injected security fixture. A confirmed Stripe PaymentIntent cannot change
    // destination. The strict double serves store B on B's retrieve, then store A
    // on A's retrieve, so the store-scoped lookup is what keeps A's order hidden.
    for (const shape of ["empty", "different-amount"] as const) {
      vi.mocked(sendOrderAuthorized).mockClear();
      retrieve.mockClear();
      const storeA = await makeStore(`hid-a-${shape}`);
      const storeB = await makeStore(`hid-b-${shape}`);
      const variantA = await makeVariant(storeA.id, 500);
      const variantB = await makeVariant(storeB.id, 500);
      const paymentIntentId = `pi_${crypto.randomUUID()}`;
      const cartB = await storeScoped(storeB.id).cart.create({
        data: { storeId: storeB.id, paymentIntentId },
      });
      if (shape === "different-amount") {
        await storeScoped(storeB.id).cartLine.create({
          data: { storeId: storeB.id, cartId: cartB.id, variantId: variantB.id, qty: 2, swapRule: "exact_only" },
        });
      }
      paymentIntents.set(
        paymentIntentId,
        paymentIntent({
          amount: holdFor(500, 1),
          destination: storeB.stripeAccountId!,
          onBehalfOf: storeB.stripeAccountId!,
          storeId: storeB.id,
        }),
      );
      const pause = pauseOn("afterMissedOrderLookup");
      const loser = watch(
        placeOrder(storeB.id, 0, cartB.id, { ...CONTACT, email: `b-${shape}@t240.test` }, "pickup", null, null, paymentIntentId),
      );
      let postReadMisses = 0;
      try {
        await pause.wait();
        paymentIntents.set(
          paymentIntentId,
          paymentIntent({
            amount: holdFor(500, 1),
            destination: storeA.stripeAccountId!,
            onBehalfOf: storeA.stripeAccountId!,
            storeId: storeA.id,
          }),
        );
        const cartA = await storeScoped(storeA.id).cart.create({ data: { storeId: storeA.id } });
        await storeScoped(storeA.id).cartLine.create({
          data: { storeId: storeA.id, cartId: cartA.id, variantId: variantA.id, qty: 1, swapRule: "exact_only" },
        });
        const winner = await placeOrder(
          storeA.id,
          0,
          cartA.id,
          { ...CONTACT, email: `a-${shape}@t240.test` },
          "pickup",
          null,
          null,
          paymentIntentId,
        );
        const beforeRows = await persistedOrder(storeA.id, winner.token);
        const beforeCart = await cartSnapshot(storeB.id, cartB.id);
        checkoutTestHooks.afterPostReadLookupMiss = async () => {
          postReadMisses += 1;
        };
        pause.release();
        const outcome = await loser.settled;
        expect(outcome.ok, shape).toBe(false);
        if (!outcome.ok) {
          const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
          expect(message, shape).not.toContain(winner.token);
          expect(message, shape).toBe(
            shape === "empty"
              ? "Cart is empty"
              : "Your basket changed. Your card was not charged.",
          );
        }
        expect(postReadMisses, shape).toBe(1);
        expect(await persistedOrder(storeA.id, winner.token), shape).toEqual(beforeRows);
        expect(await cartSnapshot(storeB.id, cartB.id), shape).toEqual(beforeCart);
        expect(await counts(storeB.id), shape).toEqual({ orders: 0, customers: 0 });
        expect(sendOrderAuthorized, shape).toHaveBeenCalledTimes(1);
        expect(sendOrderAuthorized).toHaveBeenCalledWith(storeA.id, winner.token);
        expect(retrieve.mock.calls.map((call) => call[0]), shape).toEqual([paymentIntentId, paymentIntentId]);
      } finally {
        pause.release();
        checkoutTestHooks.afterPostReadLookupMiss = null;
        await loser.settled;
      }
    }
  }, 30_000);

  it("replay ignores invalid contact and a lowered quantity limit", async () => {
    const badContact: Contact = { name: "Ada Buyer", phone: "+15551234567", email: "not-an-email" };
    const contactCase = await seedPricedCart("bad-contact");
    const contactPause = pauseOn("afterMissedOrderLookup");
    const contactLoser = watch(
      placeOrder(contactCase.store.id, 0, contactCase.cart.id, badContact, "pickup", null, null, contactCase.paymentIntentId),
    );
    try {
      await contactPause.wait();
      const winner = await placeOrder(
        contactCase.store.id,
        0,
        contactCase.cart.id,
        CONTACT,
        "pickup",
        null,
        null,
        contactCase.paymentIntentId,
      );
      const beforeRows = await persistedOrder(contactCase.store.id, winner.token);
      await addLine(contactCase.store.id, contactCase.cart.id, contactCase.variant.id, 2);
      const beforeCart = await cartSnapshot(contactCase.store.id, contactCase.cart.id);
      contactPause.release();
      const resumed = await contactLoser.promise;
      expect(resumed.token).toBe(winner.token);
      expect(await persistedOrder(contactCase.store.id, winner.token)).toEqual(beforeRows);
      expect(await cartSnapshot(contactCase.store.id, contactCase.cart.id)).toEqual(beforeCart);
      expect(sendOrderAuthorized).toHaveBeenCalledTimes(1);
    } finally {
      contactPause.release();
      await contactLoser.settled;
    }

    vi.mocked(sendOrderAuthorized).mockClear();
    retrieve.mockClear();
    const limitCase = await seedPricedCart("qty-limit");
    const owned = await storeScoped(limitCase.store.id).listingVariant.findUnique({
      where: { id: limitCase.variant.id },
      include: { listing: true },
    });
    if (!owned) throw new Error("variant missing");
    const limitPause = pauseOn("afterMissedOrderLookup");
    const limitLoser = watch(
      placeOrder(limitCase.store.id, 0, limitCase.cart.id, CONTACT, "pickup", null, null, limitCase.paymentIntentId),
    );
    try {
      await limitPause.wait();
      const winner = await placeOrder(
        limitCase.store.id,
        0,
        limitCase.cart.id,
        CONTACT,
        "pickup",
        null,
        null,
        limitCase.paymentIntentId,
      );
      const beforeRows = await persistedOrder(limitCase.store.id, winner.token);
      await addLine(limitCase.store.id, limitCase.cart.id, limitCase.variant.id, 2);
      await storeScoped(limitCase.store.id).listing.update({
        where: { id: owned.listing.id },
        data: { maxPerOrder: 1 },
      });
      const beforeCart = await cartSnapshot(limitCase.store.id, limitCase.cart.id);
      expect(beforeCart.lines.map((line) => line.qty)).toEqual([2]);
      limitPause.release();
      const resumed = await limitLoser.promise;
      expect(resumed.token).toBe(winner.token);
      expect(await persistedOrder(limitCase.store.id, winner.token)).toEqual(beforeRows);
      expect(await cartSnapshot(limitCase.store.id, limitCase.cart.id)).toEqual(beforeCart);
      expect(sendOrderAuthorized).toHaveBeenCalledTimes(1);
      expect(sendOrderAuthorized).toHaveBeenCalledWith(limitCase.store.id, winner.token);
    } finally {
      limitPause.release();
      await limitLoser.settled;
    }
  }, 20_000);

  it("missing cart replays only when an order exists", async () => {
    const seeded = await seedPricedCart("deleted-cart");
    const winner = await placeOrder(
      seeded.store.id,
      0,
      seeded.cart.id,
      CONTACT,
      "pickup",
      null,
      null,
      seeded.paymentIntentId,
    );
    await storeScoped(seeded.store.id).cartLine.deleteMany({ where: { cartId: seeded.cart.id } });
    await storeScoped(seeded.store.id).cart.delete({ where: { id: seeded.cart.id } });
    const beforeRows = await persistedOrder(seeded.store.id, winner.token);
    vi.mocked(sendOrderAuthorized).mockClear();
    retrieve.mockClear();
    const replay = await placeOrder(
      seeded.store.id,
      0,
      seeded.cart.id,
      CONTACT,
      "pickup",
      null,
      null,
      seeded.paymentIntentId,
    );
    expect(replay.token).toBe(winner.token);
    expect(await persistedOrder(seeded.store.id, winner.token)).toEqual(beforeRows);
    expect(sendOrderAuthorized).not.toHaveBeenCalled();
    expect(retrieve.mock.calls.map((call) => call[0])).toEqual([seeded.paymentIntentId]);

    const fresh = await makeStore("missing-cart");
    const missingId = `pi_missing_${crypto.randomUUID()}`;
    const missingCartId = `cart_${crypto.randomUUID()}`;
    paymentIntents.set(
      missingId,
      paymentIntent({
        amount: 550,
        destination: fresh.stripeAccountId!,
        onBehalfOf: fresh.stripeAccountId!,
        storeId: fresh.id,
      }),
    );
    await expect(
      placeOrder(fresh.id, 0, missingCartId, CONTACT, "pickup", null, null, missingId),
    ).rejects.toThrow("Cart is empty");
    expect(await counts(fresh.id)).toEqual({ orders: 0, customers: 0 });
    expect(sendOrderAuthorized).not.toHaveBeenCalled();
  }, 20_000);

  it("replay preserves winner rows and the next checkout intent", async () => {
    const seeded = await seedPricedCart("next-intent");
    const pause = pauseOn("afterMissedOrderLookup");
    const loser = watch(
      placeOrder(seeded.store.id, 0, seeded.cart.id, CONTACT, "pickup", null, null, seeded.paymentIntentId),
    );
    const nextIntent = `pi_same_${crypto.randomUUID()}`;
    try {
      await pause.wait();
      const winner = await placeOrder(
        seeded.store.id,
        0,
        seeded.cart.id,
        CONTACT,
        "pickup",
        null,
        null,
        seeded.paymentIntentId,
      );
      const beforeRows = await persistedOrder(seeded.store.id, winner.token);
      await addLine(seeded.store.id, seeded.cart.id, seeded.variant.id, 1);
      await storeScoped(seeded.store.id).cart.update({
        where: { id: seeded.cart.id },
        data: { paymentIntentId: nextIntent },
      });
      const beforeCart = await cartSnapshot(seeded.store.id, seeded.cart.id);
      expect(beforeCart.paymentIntentId).toBe(nextIntent);
      expect(beforeCart.lines.map((line) => line.qty)).toEqual([1]);
      pause.release();
      const resumed = await loser.promise;
      expect(resumed.token).toBe(winner.token);
      expect(await persistedOrder(seeded.store.id, winner.token)).toEqual(beforeRows);
      expect(await cartSnapshot(seeded.store.id, seeded.cart.id)).toEqual(beforeCart);
      expect(retrieve.mock.calls.map((call) => call[0])).toEqual([
        seeded.paymentIntentId,
        seeded.paymentIntentId,
      ]);
      expect(retrieve.mock.calls.some((call) => call[0] === nextIntent)).toBe(false);
      expect(sendOrderAuthorized).toHaveBeenCalledTimes(1);
      expect(sendOrderAuthorized).toHaveBeenCalledWith(seeded.store.id, winner.token);
    } finally {
      pause.release();
      await loser.settled;
    }
  }, 20_000);

  it("a failed winner still releases the gate and the loser settles", async () => {
    const seeded = await seedPricedCart("winner-fails");
    const pause = pauseOn("afterMissedOrderLookup");
    const loser = watch(
      placeOrder(seeded.store.id, 0, seeded.cart.id, CONTACT, "pickup", null, null, seeded.paymentIntentId),
    );
    const started = Date.now();
    let outcome: Awaited<typeof loser.settled> | undefined;
    try {
      await pause.wait();
      await expect(
        placeOrder(
          seeded.store.id,
          0,
          seeded.cart.id,
          { ...CONTACT, email: "not-an-email" },
          "pickup",
          null,
          null,
          seeded.paymentIntentId,
        ),
      ).rejects.toThrow(/Name, email, and a valid phone number are required/);
      expect(await counts(seeded.store.id)).toEqual({ orders: 0, customers: 0 });
      expect(sendOrderAuthorized).not.toHaveBeenCalled();
    } finally {
      pause.release();
      outcome = await loser.settled;
    }
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      expect(await counts(seeded.store.id)).toEqual({ orders: 1, customers: 1 });
      expect(sendOrderAuthorized).toHaveBeenCalledTimes(1);
      expect(sendOrderAuthorized).toHaveBeenCalledWith(seeded.store.id, outcome.value.token);
      const order = await storeScoped(seeded.store.id).order.findUnique({ where: { id: outcome.value.token } });
      expect(order?.paymentIntentId).toBe(seeded.paymentIntentId);
    }
  }, 15_000);

  it("gate cleanup survives arrival and winner failure and asserts loser outcome", async () => {
    const thrown = await seedPricedCart("arrival-throw");
    checkoutTestHooks.afterMissedOrderLookup = async () => {
      throw new Error("arrival failed before the gate");
    };
    const thrownLoser = watch(
      placeOrder(thrown.store.id, 0, thrown.cart.id, CONTACT, "pickup", null, null, thrown.paymentIntentId),
    );
    let arrivalRejection = "";
    try {
      await expect(thrownLoser.promise).rejects.toThrow(/arrival failed before the gate/);
    } finally {
      const settled = await Promise.allSettled([thrownLoser.promise]);
      const first = settled[0];
      if (first?.status === "rejected") {
        arrivalRejection = first.reason instanceof Error ? first.reason.message : String(first.reason);
      }
      checkoutTestHooks.afterMissedOrderLookup = null;
    }
    expect(arrivalRejection).toBe("arrival failed before the gate");
    expect(await counts(thrown.store.id)).toEqual({ orders: 0, customers: 0 });

    const aborted = await seedPricedCart("arrival-assert");
    const pause = pauseOn("afterMissedOrderLookup");
    const loser = watch(
      placeOrder(aborted.store.id, 0, aborted.cart.id, CONTACT, "pickup", null, null, aborted.paymentIntentId),
    );
    let retained = "";
    let loserToken = "";
    try {
      await pause.wait();
      throw new Error("arrival assertion failed");
    } catch (err) {
      retained = err instanceof Error ? err.message : String(err);
    } finally {
      pause.release();
      const outcome = await loser.settled;
      if (outcome.ok) loserToken = outcome.value.token;
    }
    expect(retained).toBe("arrival assertion failed");
    expect(loserToken).not.toBe("");
    const order = await storeScoped(aborted.store.id).order.findUnique({ where: { id: loserToken } });
    expect(order?.paymentIntentId).toBe(aborted.paymentIntentId);
    expect(await counts(aborted.store.id)).toEqual({ orders: 1, customers: 1 });
    expect(sendOrderAuthorized).toHaveBeenCalledTimes(1);
    expect(sendOrderAuthorized).toHaveBeenCalledWith(aborted.store.id, loserToken);
  }, 20_000);

  async function placeWithThrowingHooks(label: string, vercel: "1" | undefined) {
    const calls = { missed: 0, around: 0, post: 0 };
    const seeded = await seedPricedCart(label);
    checkoutTestHooks.afterMissedOrderLookup = async () => {
      calls.missed += 1;
      throw new Error("missed hook");
    };
    checkoutTestHooks.aroundCartRead = async () => {
      calls.around += 1;
      throw new Error("around hook");
    };
    checkoutTestHooks.afterPostReadLookupMiss = async () => {
      calls.post += 1;
      throw new Error("post hook");
    };
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", vercel ?? "");
    try {
      const placed = await placeOrder(
        seeded.store.id,
        0,
        seeded.cart.id,
        CONTACT,
        "pickup",
        null,
        null,
        seeded.paymentIntentId,
      );
      expect(calls).toEqual({ missed: 0, around: 0, post: 0 });
      const order = await storeScoped(seeded.store.id).order.findUnique({ where: { id: placed.token } });
      expect(order?.status).toBe("AUTHORIZED");
      expect(order?.paymentIntentId).toBe(seeded.paymentIntentId);
      expect(await counts(seeded.store.id)).toEqual({ orders: 1, customers: 1 });
      expect(sendOrderAuthorized).toHaveBeenCalledWith(seeded.store.id, placed.token);
    } finally {
      vi.unstubAllEnvs();
      checkoutTestHooks.afterMissedOrderLookup = null;
      checkoutTestHooks.aroundCartRead = null;
      checkoutTestHooks.afterPostReadLookupMiss = null;
    }
  }

  it("checkout test hooks are ignored outside NODE_ENV=test", async () => {
    await placeWithThrowingHooks("hooks-off", undefined);
  }, 20_000);

  it("all checkout hooks are ignored in production with and without Vercel", async () => {
    await placeWithThrowingHooks("hooks-prod", undefined);
    vi.mocked(sendOrderAuthorized).mockClear();
    await placeWithThrowingHooks("hooks-vercel", "1");
  }, 20_000);
});

