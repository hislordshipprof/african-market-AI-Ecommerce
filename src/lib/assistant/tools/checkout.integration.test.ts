import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => fn,
  revalidateTag: () => {},
}));

import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../../db";
import { quoteCheckout } from "../../checkout/service";
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
      await scoped.cart.deleteMany({});
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
});
