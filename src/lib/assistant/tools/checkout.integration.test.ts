import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => fn,
  revalidateTag: () => {},
}));

import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../../db";
import { quoteCheckout, recordAuthorizedOrder } from "../../checkout/service";
import { computeQuote } from "../../checkout/quote";
import { readServiceFeeSettings } from "../../order/service-fee-settings";
import { loadCheckoutDraft } from "../checkout-draft";
import { assistantTools, type AssistantContext } from "./index";

const hasDb = !!process.env.DATABASE_URL;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const CONTACT = { name: "Ada", email: "ada@example.com", phone: "+12025550123" };

type Run = (name: string, input: unknown) => Promise<Record<string, unknown>>;

describe.skipIf(!hasDb)("assistant checkout handoff tools (#247)", () => {
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  let cartA = "";
  let conversationA = "";
  let cartB = "";
  let conversationB = "";
  let lineId = "";
  let variantId = "";

  beforeAll(async () => {
    raw = testPrismaClient();
    storeA = (await raw.store.create({
      data: { slug: `co-a-${suffix}`, name: "Checkout A", themePreset: "palm-and-shea", hours: undefined, timezone: "America/Chicago", prepTimeMinutes: 30, minimumOrderCents: 1000, pickupEnabled: true },
    })).id;
    storeB = (await raw.store.create({
      data: { slug: `co-b-${suffix}`, name: "Checkout B", themePreset: "palm-and-shea", pickupEnabled: false },
    })).id;
    const listing = await storeScoped(storeA).listing.create({
      data: { storeId: storeA, customName: "Egusi", price: 900, stockMode: "counted", qty: 10, variants: { create: { label: "1 lb", price: 900, weightG: 454 } } },
      include: { variants: true },
    });
    variantId = listing.variants[0].id;
    cartA = (await storeScoped(storeA).cart.create({ data: { storeId: storeA, source: "manual" } })).id;
    lineId = (await storeScoped(storeA).cartLine.create({ data: { storeId: storeA, cartId: cartA, variantId, qty: 2 } })).id;
    conversationA = (await storeScoped(storeA).aiConversation.create({
      data: { storeId: storeA, cartId: cartA, model: "claude-haiku-5-5", messages: [] },
    })).id;
    cartB = (await storeScoped(storeB).cart.create({ data: { storeId: storeB, source: "manual" } })).id;
    conversationB = (await storeScoped(storeB).aiConversation.create({
      data: { storeId: storeB, cartId: cartB, model: "claude-haiku-5-5", messages: [] },
    })).id;
  });

  afterAll(async () => {
    for (const id of [storeA, storeB].filter(Boolean)) {
      const scoped = storeScoped(id);
      await scoped.orderLine.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.customer.deleteMany({});
      await scoped.cart.deleteMany({});
      await scoped.stockEvent.deleteMany({});
      await scoped.listing.deleteMany({});
    }
    await raw.store.deleteMany({ where: { id: { in: [storeA, storeB].filter(Boolean) } } });
    await raw.$disconnect();
  });

  function runner(overrides: Partial<AssistantContext> = {}): Run {
    const tools = assistantTools({
      storeId: storeA,
      cartId: cartA,
      conversationId: conversationA,
      actorUserId: null,
      ...overrides,
    }) as unknown as Record<string, { execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>> }>;
    return (name, input) => tools[name].execute(input, { toolCallId: `call-${name}`, messages: [] });
  }

  it("offers today's pickup slots from the server and saves the chosen one as the store's draft for this cart", async () => {
    // Midday Chicago: after 23:00 the only slot left today is ASAP.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-14T18:05:00Z"), shouldAdvanceTime: true });
    onTestFinished(() => { vi.useRealTimers(); });
    const run = runner();
    const options = await run("get_fulfillment_options", {});
    expect(options.ok).toBe(true);
    const slots = (options.pickup as { slots: Array<{ slotId: string; label: string }> }).slots;
    expect(slots[0]).toEqual({ slotId: "asap", label: "As soon as it is ready" });
    const later = slots[1];
    expect(later.label).toMatch(/C[SD]T$/);

    expect(await run("set_fulfillment", { fulfillment: "pickup", slot_id: "2020-01-01T10:00:00.000Z" }))
      .toMatchObject({ ok: false, code: "slot_not_offered" });
    expect(await loadCheckoutDraft(storeA, cartA)).toBeNull();

    expect(await run("set_fulfillment", { fulfillment: "pickup", slot_id: later.slotId }))
      .toMatchObject({ ok: true, slotId: later.slotId, slotLabel: later.label });
    expect(await loadCheckoutDraft(storeA, cartA)).toEqual({ fulfillment: "pickup", slot: { id: later.slotId, label: later.label } });
  });

  it("while the store is closed, offers the queued order and later times by the checkout's rules, and saves the choice", async () => {
    const hours = Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day) => [day, "9:00 AM - 5:00 PM"]));
    const closed = (await raw.store.create({
      data: { slug: `co-closed-${suffix}`, name: "Checkout closed", themePreset: "palm-and-shea", hours, timezone: "America/Chicago", prepTimeMinutes: 30, minimumOrderCents: 0, pickupEnabled: true },
    })).id;
    const cart = (await storeScoped(closed).cart.create({ data: { storeId: closed, source: "ai" } })).id;
    const conversationId = (await storeScoped(closed).aiConversation.create({ data: { storeId: closed, cartId: cart, model: "claude-haiku-5-5", messages: [] } })).id;
    onTestFinished(async () => {
      vi.useRealTimers();
      await storeScoped(closed).cart.deleteMany({});
      await raw.store.delete({ where: { id: closed } });
    });
    // Monday 8:00 PM in Chicago: closed until Tuesday 9:00 AM.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-17T02:00:00Z"), shouldAdvanceTime: true });
    const run = runner({ storeId: closed, cartId: cart, conversationId });
    const options = await run("get_fulfillment_options", {});
    const pickup = options.pickup as { slots: Array<{ slotId: string; label: string }>; message?: string };
    expect(pickup.slots).toEqual([{ slotId: "asap", label: "When the store opens: Tue 9:00 AM CT, ready about 9:30 AM" }]);
    expect(pickup.message).toBeUndefined();
    expect(await run("set_fulfillment", { fulfillment: "pickup", slot_id: "asap" })).toMatchObject({ ok: true, slotId: "asap" });
    expect(await loadCheckoutDraft(closed, cart)).toEqual({ fulfillment: "pickup", slot: { id: "asap", label: "When the store opens: Tue 9:00 AM CT, ready about 9:30 AM" } });

    // With a pickup schedule, the scheduled times of the coming days are offered too, as on the checkout page.
    const windows = Array.from({ length: 7 }, () => [{ start: 9 * 60, end: 17 * 60 }]);
    await raw.store.update({ where: { id: closed }, data: { pickupSlotSettings: { slotMinutes: 60, leadMinutes: 120, capacity: 5, daysAhead: 2, closedDates: [], windows } } });
    const scheduled = (await run("get_fulfillment_options", {})).pickup as { slots: Array<{ slotId: string; label: string }> };
    expect(scheduled.slots[0].slotId).toBe("asap");
    expect(scheduled.slots[1]).toEqual({ slotId: "2026-11-17T15:00:00.000Z", label: expect.stringMatching(/^Tue, Nov 17, 9:00/) });
    expect(await run("set_fulfillment", { fulfillment: "pickup", slot_id: "2026-11-17T15:00:00.000Z" })).toMatchObject({ ok: true });
    expect(await run("prepare_checkout", {})).toMatchObject({ ok: false, code: "cart_empty" });
  });

  it("a store with pickup off says so plainly and saves nothing", async () => {
    const run = runner({ storeId: storeB, cartId: cartB, conversationId: conversationB });
    const options = await run("get_fulfillment_options", {});
    expect(options.pickup).toMatchObject({ offered: false, slots: [] });
    expect(String((options.pickup as { message: string }).message)).toContain("does not offer pickup");
    expect(await run("set_fulfillment", { fulfillment: "pickup", slot_id: "asap" })).toMatchObject({ ok: false, code: "pickup_unavailable" });
    expect(await loadCheckoutDraft(storeB, cartB)).toBeNull();
  });

  it("prepare_checkout draws the Review card from the normal quote and creates no hold or order", async () => {
    const run = runner();
    await run("set_fulfillment", { fulfillment: "pickup", slot_id: "asap" });
    const card = await run("prepare_checkout", {});
    const expected = computeQuote(1000, [{ price: 900, qty: 2, maxPerOrder: null }], CONTACT, "pickup", await readServiceFeeSettings());
    expect(card).toMatchObject({
      ok: true,
      lines: [{ lineId, name: "Egusi", packLabel: "1 lb", qty: 2, unitPriceCents: 900, lineTotalCents: 1800, mayBeUnavailable: false }],
      fulfillment: { kind: "pickup", slotId: "asap", slotLabel: "As soon as it is ready" },
      subtotalCents: 1800,
      serviceFeeCents: expected.serviceFeeCents,
      taxCents: 0,
      totalCents: expected.totalCents,
      bufferCents: expected.bufferCents,
      holdCents: expected.holdCents,
      problems: [],
      checkoutPath: "/checkout",
    });
    expect(JSON.stringify(card)).not.toMatch(/clientSecret|paymentIntent|pi_/);
    const cart = await storeScoped(storeA).cart.findUnique({ where: { id: cartA } });
    expect(cart?.paymentIntentId).toBeNull();
    expect(await storeScoped(storeA).order.count()).toBe(0);
  });

  it("the card is information: checkout quotes the current basket after the cart changes", async () => {
    const run = runner();
    const card = await run("prepare_checkout", {});
    expect(card.subtotalCents).toBe(1800);
    await storeScoped(storeA).cartLine.update({ where: { id: lineId }, data: { qty: 3 } });
    const quote = await quoteCheckout(storeA, 1000, cartA, CONTACT, "pickup");
    expect(quote.subtotalCents).toBe(2700);
    expect((await run("prepare_checkout", {})).subtotalCents).toBe(2700);
    await storeScoped(storeA).cartLine.update({ where: { id: lineId }, data: { qty: 2 } });
  });

  it("names the minimum order and an empty cart, but not the contact entered at checkout", async () => {
    await storeScoped(storeA).cartLine.update({ where: { id: lineId }, data: { qty: 1 } });
    const card = await runner()("prepare_checkout", {});
    expect(card.problems).toEqual(["Minimum order is $10.00."]);
    await storeScoped(storeA).cartLine.update({ where: { id: lineId }, data: { qty: 2 } });
    expect(await runner({ storeId: storeB, cartId: cartB, conversationId: conversationB })("prepare_checkout", {}))
      .toMatchObject({ ok: false, code: "cart_empty" });
  });

  it("the draft is store-scoped: another store cannot read or write it", async () => {
    expect(await loadCheckoutDraft(storeB, cartA)).toBeNull();
    await expect(
      storeScoped(storeB).aiConversation.update({ where: { id: conversationA }, data: { checkoutDraft: { fulfillment: "pickup", slot: "asap" } } }),
    ).rejects.toThrow();
    const crossWrite = await runner({ conversationId: conversationB })("set_fulfillment", { fulfillment: "pickup", slot_id: "asap" })
      .catch((error: unknown) => ({ thrown: error }));
    expect("thrown" in crossWrite || crossWrite.ok === false).toBe(true);
    const b = await storeScoped(storeB).aiConversation.findUnique({ where: { id: conversationB } });
    expect(b?.checkoutDraft).toBeNull();
  });

  it("placing the order clears the draft, so the next checkout on this cart starts fresh", async () => {
    const scoped = storeScoped(storeA);
    const cart = await scoped.cart.create({ data: { storeId: storeA, source: "manual" } });
    await scoped.cartLine.create({ data: { storeId: storeA, cartId: cart.id, variantId, qty: 2 } });
    const conversation = await scoped.aiConversation.create({
      data: { storeId: storeA, cartId: cart.id, model: "claude-haiku-5-5", messages: [] },
    });
    await runner({ cartId: cart.id, conversationId: conversation.id })("set_fulfillment", { fulfillment: "pickup", slot_id: "asap" });
    expect(await loadCheckoutDraft(storeA, cart.id)).not.toBeNull();

    const lines = [{ variantId, qty: 2, price: 900, swapRule: "exact_only", substituteVariantId: null }];
    await recordAuthorizedOrder(storeA, {
      cartId: cart.id,
      contact: CONTACT,
      fulfillment: "pickup",
      pickupSlot: null,
      notes: null,
      paymentIntentId: `pi_draft_${suffix}`,
      quote: computeQuote(0, lines.map((line) => ({ ...line, maxPerOrder: null })), CONTACT, "pickup", await readServiceFeeSettings()),
      lines,
    });

    await scoped.cartLine.create({ data: { storeId: storeA, cartId: cart.id, variantId, qty: 1 } });
    expect(await loadCheckoutDraft(storeA, cart.id)).toBeNull();
  });
});
