import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => fn,
  revalidateTag: () => {},
}));

import { testPrismaClient } from "@/lib/test-prisma";
import { setAddressProvider, fakeAddressBackend } from "../../address/provider";
import { storeScoped } from "../../db";
import { listStoreThreads } from "../../support/thread";
import { assistantTools, type AssistantContext } from "./index";

const hasDb = !!process.env.DATABASE_URL;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** The seeded Park Place store; 3700 Main St is 7.5 mi away, 1600 Pennsylvania Ave is not. */
const PARK_PLACE = { lat: 29.693857800118, lng: -95.266257879374 };
const DAILY_HOURS = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [day, { open: "09:00", close: "20:00" }]),
);

type Run = (name: string, input: unknown) => Promise<Record<string, unknown>>;

describe.skipIf(!hasDb)("assistant store questions", () => {
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  const alice = `sq-alice-${suffix}`;
  const bob = `sq-bob-${suffix}`;
  let cartA = "";
  let conversationA = "";
  let cartB = "";
  let conversationB = "";

  beforeAll(async () => {
    raw = testPrismaClient();
    storeA = (await raw.store.create({
      data: {
        slug: `sq-a-${suffix}`,
        name: "Questions A",
        themePreset: "palm-and-shea",
        hours: DAILY_HOURS,
        minimumOrderCents: 3500,
        pickupEnabled: true,
        storeDeliveryEnabled: true,
        storeDeliveryFeeCents: 599,
        deliveryRadiusMi: 8,
        ...PARK_PLACE,
      },
    })).id;
    storeB = (await raw.store.create({
      data: { slug: `sq-b-${suffix}`, name: "Questions B", themePreset: "palm-and-shea" },
    })).id;
    await raw.user.createMany({
      data: [alice, bob].map((id) => ({ id, name: id, email: `${id}@example.com` })),
    });
    const aliceA = await storeScoped(storeA).customer.create({ data: { storeId: storeA, userId: alice, name: "Alice" } });
    await storeScoped(storeA).customer.create({ data: { storeId: storeA, userId: bob, name: "Bob" } });
    await storeScoped(storeB).customer.create({ data: { storeId: storeB, userId: alice, name: "Alice" } });
    const listing = await storeScoped(storeA).listing.create({
      data: { storeId: storeA, customName: "Egusi", price: 900, stockMode: "counted", qty: 10, variants: { create: { label: "1 lb", price: 900, weightG: 454 } } },
      include: { variants: true },
    });
    const order = await storeScoped(storeA).order.create({
      data: {
        storeId: storeA,
        number: 1001,
        customerId: aliceA.id,
        status: "PICKING",
        fulfillment: "pickup",
        subtotalCents: 1800,
        bufferCents: 180,
        totalAuthorizedCents: 1980,
        totalCents: 1800,
        trackingToken: `sq-token-${suffix}`,
        createdAt: new Date(Date.now() - 120_000),
        acceptedAt: new Date(Date.now() - 60_000),
      },
    });
    await storeScoped(storeA).orderLine.create({
      data: { storeId: storeA, orderId: order.id, listingVariantId: listing.variants[0].id, qtyOrdered: 2, unitPriceCents: 900 },
    });
    cartA = (await storeScoped(storeA).cart.create({ data: { storeId: storeA, source: "manual" } })).id;
    conversationA = (await storeScoped(storeA).aiConversation.create({
      data: { storeId: storeA, cartId: cartA, model: "claude-haiku-5-5", messages: [] },
    })).id;
    cartB = (await storeScoped(storeB).cart.create({ data: { storeId: storeB, source: "manual" } })).id;
    conversationB = (await storeScoped(storeB).aiConversation.create({
      data: { storeId: storeB, cartId: cartB, model: "claude-haiku-5-5", messages: [] },
    })).id;
  });

  afterEach(() => setAddressProvider(null));

  afterAll(async () => {
    for (const id of [storeA, storeB].filter(Boolean)) {
      const scoped = storeScoped(id);
      await scoped.supportMessage.deleteMany({});
      await scoped.supportThread.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.cart.deleteMany({});
      await scoped.listing.deleteMany({});
      await scoped.customer.deleteMany({});
    }
    await raw.user.deleteMany({ where: { id: { in: [alice, bob] } } });
    await raw.store.deleteMany({ where: { id: { in: [storeA, storeB].filter(Boolean) } } });
    await raw.$disconnect();
  });

  function runner(overrides: Partial<AssistantContext>): Run {
    const tools = assistantTools({
      storeId: storeA,
      cartId: cartA,
      conversationId: conversationA,
      actorUserId: null,
      ...overrides,
    }) as unknown as Record<string, { execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>> }>;
    return (name, input) => tools[name].execute(input, { toolCallId: `call-${name}`, messages: [] });
  }

  it("get_order_status returns only the signed-in customer's own order in this store", async () => {
    const own = await runner({ actorUserId: alice })("get_order_status", {});
    expect(own).toMatchObject({
      ok: true,
      orders: [{ number: 1001, status: "PICKING", lines: [{ name: "Egusi", qty: 2 }], lastEvent: { type: "accepted" } }],
    });

    expect(await runner({ actorUserId: bob })("get_order_status", { order_number: 1001 })).toMatchObject({
      ok: false,
      code: "order_not_found",
    });
    expect(await runner({ actorUserId: null })("get_order_status", { order_number: 1001 })).toMatchObject({
      ok: false,
      code: "sign_in_required",
    });
    const otherStore = await runner({ storeId: storeB, cartId: cartB, conversationId: conversationB, actorUserId: alice })(
      "get_order_status",
      { order_number: 1001 },
    );
    expect(otherStore).toMatchObject({ ok: false, code: "order_not_found" });

    const logged = await storeScoped(storeA).aiAction.findMany({ where: { conversationId: conversationA, tool: "get_order_status" } });
    expect(logged).toHaveLength(3);
    expect(JSON.stringify(logged)).not.toContain("sq-token-");
  });

  it("my usual: get_order_status gives the customer's own lines in this store with current variant ids, never another store's or customer's", async () => {
    const order = (number: number, customerId: string, storeId: string) => ({
      storeId, number, customerId, status: "COMPLETED", fulfillment: "pickup", subtotalCents: 500, bufferCents: 50,
      totalAuthorizedCents: 550, totalCents: 500, trackingToken: `sq-usual-${number}-${suffix}`,
    });
    const bobA = await storeScoped(storeA).customer.findFirstOrThrow({ where: { userId: bob } });
    const aliceB = await storeScoped(storeB).customer.findFirstOrThrow({ where: { userId: alice } });
    const stockfish = await storeScoped(storeA).listing.create({
      data: { storeId: storeA, customName: "Stockfish", price: 1500, stockMode: "unlimited", variants: { create: { label: "Cut", price: 1500, weightG: 300 } } },
      include: { variants: true },
    });
    const palmB = await storeScoped(storeB).listing.create({
      data: { storeId: storeB, customName: "Palm oil", price: 700, stockMode: "unlimited", variants: { create: { label: "1 L", price: 700, weightG: 900 } } },
      include: { variants: true },
    });
    const bobOrder = await storeScoped(storeA).order.create({ data: order(1501, bobA.id, storeA) });
    await storeScoped(storeA).orderLine.create({
      data: { storeId: storeA, orderId: bobOrder.id, listingVariantId: stockfish.variants[0].id, qtyOrdered: 1, unitPriceCents: 1500 },
    });
    const aliceOrderB = await storeScoped(storeB).order.create({ data: order(2501, aliceB.id, storeB) });
    await storeScoped(storeB).orderLine.create({
      data: { storeId: storeB, orderId: aliceOrderB.id, listingVariantId: palmB.variants[0].id, qtyOrdered: 3, unitPriceCents: 700 },
    });
    const egusi = await storeScoped(storeA).listing.findFirstOrThrow({ where: { customName: "Egusi" }, include: { variants: true } });
    const aliceCart = async (storeId: string) => {
      const cart = await storeScoped(storeId).cart.create({ data: { storeId, source: "ai", userId: alice } });
      const talk = await storeScoped(storeId).aiConversation.create({ data: { storeId, cartId: cart.id, model: "claude-haiku-5-5", messages: [] } });
      return { storeId, cartId: cart.id, conversationId: talk.id, actorUserId: alice };
    };
    const inStoreA = await aliceCart(storeA);
    const inStoreB = await aliceCart(storeB);

    const usual = await runner({ actorUserId: alice })("get_order_status", {});
    expect(usual).toMatchObject({
      ok: true,
      orders: [{ number: 1001, lines: [{ name: "Egusi", qty: 2, listingId: egusi.id, variantId: egusi.variants[0].id, mayBeUnavailable: false }] }],
    });
    const seen = JSON.stringify(usual);
    expect(seen).not.toContain(stockfish.variants[0].id);
    expect(seen).not.toContain(palmB.variants[0].id);

    // Reordering adds those lines to this store's cart.
    const reordered = await runner(inStoreA)("add_to_cart", { items: [{ variant_id: egusi.variants[0].id, qty: 2 }] });
    expect(reordered, JSON.stringify(reordered)).toMatchObject({ ok: true, added: 2 });

    const inB = await runner(inStoreB)("get_order_status", {});
    expect(inB).toMatchObject({ ok: true, orders: [{ number: 2501, lines: [{ name: "Palm oil", variantId: palmB.variants[0].id }] }] });
    expect(JSON.stringify(inB)).not.toContain(egusi.variants[0].id);
    // Store A's variant cannot reach store B's cart.
    expect(await runner(inStoreB)("add_to_cart", { items: [{ variant_id: egusi.variants[0].id, qty: 1 }] }))
      .toMatchObject({ ok: false, code: "variant_not_found" });
    expect(JSON.stringify(await runner({ actorUserId: bob })("get_order_status", {}))).not.toContain(egusi.variants[0].id);
  });

  it("check_delivery_area compares the geocoded address with the store's radius, signed out", async () => {
    setAddressProvider(fakeAddressBackend());
    const run = runner({ actorUserId: null });
    const inside = await run("check_delivery_area", { line1: "3700 Main St", city: "Houston", state: "TX", zip: "77002" });
    expect(inside).toMatchObject({ ok: true, withinRadius: true, distanceMi: 7.5, radiusMi: 8, storeDelivery: true, pickup: true });

    const outside = await run("check_delivery_area", {
      line1: "1600 Pennsylvania Ave NW",
      city: "Washington",
      state: "DC",
      zip: "20500",
    });
    expect(outside).toMatchObject({ ok: true, withinRadius: false, storeDelivery: false, pickup: true });
  });

  it("get_store_info reads hours and policies from the store, signed out", async () => {
    const info = await runner({ actorUserId: null })("get_store_info", {});
    expect(info).toMatchObject({
      ok: true,
      hours: DAILY_HOURS,
      minimumOrderCents: 3500,
      pickup: true,
      storeDelivery: { enabled: true, feeCents: 599, radiusMi: 8 },
    });
    expect(info).not.toHaveProperty("orders");
  });

  it("forward_to_store opens the order's support thread with the order context and refuses guests and other customers", async () => {
    expect(await runner({ actorUserId: null })("forward_to_store", { issue: "Stale egusi" })).toMatchObject({
      ok: false,
      code: "sign_in_required",
    });
    expect(await runner({ actorUserId: bob })("forward_to_store", { order_number: 1001, issue: "Stale egusi" })).toMatchObject({
      ok: false,
      code: "order_not_found",
    });
    expect(await listStoreThreads(storeA)).toHaveLength(0);

    const forwarded = await runner({ actorUserId: alice })("forward_to_store", {
      order_number: 1001,
      issue: "My egusi was stale, I want a refund.",
    });
    expect(forwarded).toMatchObject({ ok: true, orderNumber: 1001 });

    const threads = await listStoreThreads(storeA);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ orderNumber: 1001, unread: 1 });
    const message = await storeScoped(storeA).supportMessage.findFirstOrThrow({ where: { threadId: threads[0].id } });
    expect(message.sender).toBe("customer");
    expect(message.body).toContain("Order #1001");
    expect(message.body).toContain("2 × Egusi");
    expect(message.body).toContain("My egusi was stale, I want a refund.");
    expect(await storeScoped(storeB).supportThread.findMany()).toEqual([]);

    // A 25-line order with the longest issue still fits the 1000-character message limit.
    const scoped = storeScoped(storeA);
    const aliceA = await scoped.customer.findFirstOrThrow({ where: { userId: alice } });
    const big = await scoped.order.create({
      data: {
        storeId: storeA,
        number: 1002,
        customerId: aliceA.id,
        status: "PICKING",
        fulfillment: "pickup",
        subtotalCents: 22500,
        bufferCents: 2250,
        totalAuthorizedCents: 24750,
        totalCents: 22500,
        createdAt: new Date(Date.now() - 300_000),
      },
    });
    for (let i = 1; i <= 25; i++) {
      const item = await scoped.listing.create({
        data: { storeId: storeA, customName: `Ground egusi seeds ${i}`, price: 900, stockMode: "counted", qty: 10, variants: { create: { label: "2 lb bag", price: 900, weightG: 907 } } },
        include: { variants: true },
      });
      await scoped.orderLine.create({
        data: { storeId: storeA, orderId: big.id, listingVariantId: item.variants[0].id, qtyOrdered: 1, unitPriceCents: 900 },
      });
    }
    const issue = "The egusi was stale and two items were missing. ".repeat(12).trim().slice(0, 600);
    expect(await runner({ actorUserId: alice })("forward_to_store", { order_number: 1002, issue })).toMatchObject({
      ok: true,
      orderNumber: 1002,
    });
    const bigThread = (await listStoreThreads(storeA)).find((thread) => thread.orderNumber === 1002)!;
    const bigMessage = await scoped.supportMessage.findFirstOrThrow({ where: { threadId: bigThread.id } });
    expect(bigMessage.body.length).toBeLessThanOrEqual(1000);
    expect(bigMessage.body).toContain("Order #1002");
    expect(bigMessage.body).toContain("1 × Ground egusi seeds 1 (2 lb bag)");
    expect(bigMessage.body).toMatch(/…and \d+ more/);
    expect(bigMessage.body).toContain(`Customer says: ${issue}`);
  });
});
