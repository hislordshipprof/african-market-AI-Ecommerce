import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { platformAdmin, storeScoped } from "../../db";
import { readConstraints } from "../constraints";
import { acceptanceForTurn, shownProductIds, type ShownMessage } from "../shown";
import { addToCart, setShopperNeeds, setSwapRule, showProducts, suggestSubstitutes, updateCart, type AssistantContext } from "./execute";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => fn,
  revalidateTag: () => {},
}));

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("shopper assistant extras (#476)", () => {
  const suffix = randomUUID().slice(0, 8);
  let storeA = "";
  const masters: string[] = [];
  const listing: Record<string, { listingId: string; variantId: string }> = {};

  async function master(name: string, data: Record<string, unknown> = {}) {
    const product = await platformAdmin.masterProduct.create({ data: { name: `${name} ${suffix}`, ...data } });
    masters.push(product.id);
    return product.id;
  }

  async function sell(storeId: string, masterProductId: string, price: number, stock: { stockMode: string; status?: string; qty?: number } = { stockMode: "unlimited" }) {
    const row = await storeScoped(storeId).listing.create({
      data: { storeId, masterProductId, price, frozen: false, perishable: false, ...stock },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: row.id, label: "Each", price, weightG: 100 },
    });
    return { listingId: row.id, variantId: variant.id };
  }

  async function conversation(storeId: string) {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId, source: "manual" } });
    const talk = await storeScoped(storeId).aiConversation.create({
      data: { storeId, cartId: cart.id, model: "claude-haiku-5-5", messages: [] },
    });
    return { storeId, cartId: cart.id, conversationId: talk.id, actorUserId: null } satisfies AssistantContext;
  }

  beforeAll(async () => {
    storeA = (await platformAdmin.store.create({ data: { slug: `extras-a-${suffix}`, name: "Extras A", themePreset: "palm-and-shea" } })).id;
    listing.rice = await sell(storeA, await master("Rice"), 600);
    listing.oil = await sell(storeA, await master("Oil"), 500);
    listing.iru = await sell(storeA, await master("Locust bean", {
      description: "Fermented locust bean seasoning for egusi and ogbono soup.",
      synonyms: { create: [{ term: `iru ${suffix}`, language: "yoruba" }, { term: `dawadawa ${suffix}`, language: "hausa" }] },
    }), 400);
    const greens = { categoryId: "cat_vegetables" };
    listing.ugu = await sell(storeA, await master("Ugu leaves", greens), 700, { stockMode: "status", status: "out_of_stock" });
    listing.spinach = await sell(storeA, await master("Spinach", greens), 450);
    listing.bitterleaf = await sell(storeA, await master("Bitter leaf", greens), 480, { stockMode: "counted", qty: 0 });
  });

  afterAll(async () => {
    if (storeA) {
      await storeScoped(storeA).cart.deleteMany({});
      await storeScoped(storeA).listing.deleteMany({});
      await platformAdmin.store.delete({ where: { id: storeA } });
    }
    await platformAdmin.masterProduct.deleteMany({ where: { id: { in: masters } } });
  });

  it("keeps the cart under the customer's budget and says which item would go over", async () => {
    const ctx = await conversation(storeA);
    expect(await setShopperNeeds(ctx, { budget_cents: 1000 })).toMatchObject({ ok: true, budgetCents: 1000 });
    const added = await addToCart(ctx, {
      items: [{ variant_id: listing.rice.variantId, qty: 1 }, { variant_id: listing.oil.variantId, qty: 1 }],
    });
    expect(added).toMatchObject({
      ok: true,
      subtotalCents: 600,
      items: [
        { ok: true, variantId: listing.rice.variantId, added: 1 },
        { ok: false, code: "over_budget", variantId: listing.oil.variantId, budgetCents: 1000 },
      ],
    });
    const line = (added as unknown as { items: Array<{ lineId?: string }> }).items[0].lineId!;
    expect(await updateCart(ctx, { line_id: line, qty: 2 })).toMatchObject({ ok: false, code: "over_budget" });
    // A budget is not a dietary need: it never turns the store's swap into a refund.
    expect((await readConstraints(storeA, ctx.conversationId)).budgetCents).toBe(1000);

    expect(await setShopperNeeds(ctx, { remove: ["budget"] })).not.toHaveProperty("budgetCents");
    expect(await addToCart(ctx, { items: [{ variant_id: listing.oil.variantId, qty: 1 }] })).toMatchObject({ ok: true, added: 1 });
  });

  it("explains an item from the catalog's own description and local names", async () => {
    const ctx = await conversation(storeA);
    const shown = await showProducts(ctx, { listing_ids: [listing.iru.listingId, listing.rice.listingId] });
    expect(shown).toMatchObject({
      ok: true,
      cards: [
        {
          listingId: listing.iru.listingId,
          about: "Fermented locust bean seasoning for egusi and ogbono soup.",
          alsoCalled: expect.arrayContaining([`iru ${suffix}`, `dawadawa ${suffix}`]),
        },
        { listingId: listing.rice.listingId },
      ],
    });
    // A product with no description says nothing made up.
    const rice = (shown as unknown as { cards: Array<Record<string, unknown>> }).cards[1];
    expect(rice).not.toHaveProperty("about");
    expect(rice).not.toHaveProperty("alsoCalled");
  });

  it("suggests only in-stock swaps for an out-of-stock item, ready to keep as its named substitute", async () => {
    const ctx = await conversation(storeA);
    const suggested = await suggestSubstitutes(ctx, { listing_id: listing.ugu.listingId }) as unknown as { ok: boolean; items: Array<Record<string, unknown>> };
    expect(suggested.ok).toBe(true);
    const ids = suggested.items.map((item) => item.listingId);
    expect(ids).toContain(listing.spinach.listingId);
    // An out-of-stock swap is no swap.
    expect(ids).not.toContain(listing.bitterleaf.listingId);
    expect(suggested.items.find((item) => item.listingId === listing.spinach.listingId))
      .toMatchObject({ variantId: listing.spinach.variantId, packLabel: "Each", mayBeUnavailable: false });

    // Adding the out item with no backup offers the same in-stock swaps, so the reply can suggest one.
    const plain = await addToCart(await conversation(storeA), { items: [{ variant_id: listing.ugu.variantId, qty: 1 }] });
    expect(plain).toMatchObject({ ok: true, mayBeUnavailable: true, swapRule: "store_suggests" });
    const ideas = (plain as unknown as { swapIdeas: Array<{ listingId: string; variantId: string }> }).swapIdeas;
    expect(ideas.map((idea) => idea.listingId)).toContain(listing.spinach.listingId);
    expect(ideas.map((idea) => idea.listingId)).not.toContain(listing.bitterleaf.listingId);

    // The existing swap rules keep it: ugu stays on the cart with spinach as its named substitute.
    const added = await addToCart(ctx, { items: [{ variant_id: listing.ugu.variantId, qty: 1, backup_variant_id: listing.spinach.variantId }] });
    expect(added).toMatchObject({ ok: true, mayBeUnavailable: true, swapRule: "named_substitute", substituteVariantId: listing.spinach.variantId });
    expect(added).not.toHaveProperty("swapIdeas");
    const lineId = (added as unknown as { lineId: string }).lineId;
    expect(await setSwapRule(ctx, { line_id: lineId, rule: "named_substitute", substitute_variant_id: listing.spinach.variantId })).toMatchObject({ ok: true });

    // The suggested variant id is in the chat's copy table, like a search result's.
    const messages: ShownMessage[] = [{ role: "assistant", parts: [{ type: "tool-suggest_substitutes", state: "output-available", output: suggested }] }];
    expect(shownProductIds(messages).join("\n")).toContain(listing.spinach.variantId);
  });

  it("treats a past order's lines like shown products, so yes reorders them", () => {
    const output = {
      ok: true,
      orders: [{ number: 1001, lines: [{ name: "Egusi", packLabel: "1 lb", qty: 2, listingId: "listing-egusi", variantId: "variant-egusi" }] }],
    };
    const messages: ShownMessage[] = [
      { role: "user", id: "u1", parts: [{ type: "text", text: "Reorder my usual" }] },
      { role: "assistant", parts: [{ type: "tool-get_order_status", state: "output-available", output }, { type: "text", text: "Your last order had 2 Egusi. Add it again?" }] },
      { role: "user", id: "u2", parts: [{ type: "text", text: "yes" }] },
    ];
    expect(shownProductIds(messages)).toEqual(["Egusi, 1 lb: variant-egusi"]);
    expect(acceptanceForTurn(messages, "u2", "yes").lastReplyListingIds).toEqual(["listing-egusi"]);
  });
});
