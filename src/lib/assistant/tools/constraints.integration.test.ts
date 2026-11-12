import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { platformAdmin, storeScoped, storeScopedTransaction } from "../../db";
import { listingAttributes } from "../../catalog/listing-attributes";
import { listingVerdicts, readConstraints } from "../constraints";
import { acceptanceForTurn, type ShownMessage } from "../shown";
import { addToCart, offerChoices, searchCatalog, setShopperNeeds, setSwapRule, type AssistantContext } from "./execute";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => fn,
  revalidateTag: () => {},
}));

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("shopper constraints (#485)", () => {
  const suffix = randomUUID().slice(0, 8);
  let storeA = "";
  let storeB = "";
  const masters: string[] = [];
  const ingredients: string[] = [];
  let onionId = "";
  const listing: Record<string, { listingId: string; variantId: string }> = {};

  async function master(name: string, data: Record<string, unknown>, ingredientIds: string[] = []) {
    const product = await platformAdmin.masterProduct.create({
      data: { name: `${name} ${suffix}`, ...data, ingredients: { create: ingredientIds.map((ingredientId) => ({ ingredientId })) } },
    });
    masters.push(product.id);
    return product.id;
  }

  async function sell(storeId: string, masterProductId: string, price = 300, confidence = 1) {
    const row = await storeScoped(storeId).listing.create({
      data: { storeId, masterProductId, price, stockMode: "unlimited", frozen: false, perishable: false, confidence },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: row.id, label: "Each", price, weightG: 100 },
    });
    return { listingId: row.id, variantId: variant.id };
  }

  async function conversation(storeId: string, messages: ShownMessage[] = []) {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId, source: "manual" } });
    const talk = await storeScoped(storeId).aiConversation.create({
      data: { storeId, cartId: cart.id, model: "claude-haiku-5-5", messages: messages as never },
    });
    return { storeId, cartId: cart.id, conversationId: talk.id, actorUserId: null } satisfies AssistantContext;
  }

  function items(result: unknown) {
    return (result as { items: Array<{ listingId: string; match: string; needs?: Record<string, string> }> }).items;
  }

  beforeAll(async () => {
    storeA = (await platformAdmin.store.create({ data: { slug: `need-a-${suffix}`, name: "Need A", themePreset: "palm-and-shea" } })).id;
    storeB = (await platformAdmin.store.create({ data: { slug: `need-b-${suffix}`, name: "Need B", themePreset: "palm-and-shea" } })).id;
    const onion = await platformAdmin.ingredient.create({
      data: { name: `onion ${suffix}`, synonyms: { create: [{ term: `yellow onion ${suffix}` }] } },
    });
    const tomato = await platformAdmin.ingredient.create({ data: { name: `tomato ${suffix}` } });
    onionId = onion.id;
    ingredients.push(onion.id, tomato.id);
    const known = { allergensStatus: "reviewed", dietaryStatus: "reviewed", ingredientsStatus: "reviewed" };
    listing.plain = await sell(storeA, await master("Paste plain", { ...known, dietaryClaims: ["halal", "vegan"] }, [tomato.id]));
    listing.onion = await sell(storeA, await master("Paste with onion", { ...known, dietaryClaims: ["halal", "vegan"] }, [tomato.id, onion.id]));
    listing.peanut = await sell(storeA, await master("Paste groundnut", { ...known, allergens: ["peanuts"], dietaryClaims: ["vegan"] }, [tomato.id]));
    // Low confidence: may be unavailable, so it is added with a backup.
    listing.shaky = await sell(storeA, await master("Paste shaky", { ...known, dietaryClaims: ["halal", "vegan"] }, [tomato.id]), 300, 0.3);
    const unknownMaster = await master("Paste mystery", {});
    listing.unknown = await sell(storeA, unknownMaster);
    // Store B states the same product is peanut-free; store A must never see that.
    listing.otherStore = await sell(storeB, unknownMaster);
    await storeScopedTransaction(storeB, (tx) => tx.listingAttributes.create({
      data: { listingId: listing.otherStore.listingId, storeId: storeB, allergensStatus: "known", allergens: [] },
    }));
  });

  afterAll(async () => {
    for (const storeId of [storeA, storeB].filter(Boolean)) {
      await storeScoped(storeId).cart.deleteMany({});
      await storeScoped(storeId).listing.deleteMany({});
      await platformAdmin.store.delete({ where: { id: storeId } });
    }
    await platformAdmin.masterProduct.deleteMany({ where: { id: { in: masters } } });
    await platformAdmin.ingredient.deleteMany({ where: { id: { in: ingredients } } });
  });

  it("saves an ingredient the shopper names by its synonym as a hard constraint, with no question", async () => {
    const ctx = await conversation(storeA);
    const result = await setShopperNeeds(ctx, { avoid_allergens: ["peanuts"], avoid_ingredients: [`yellow onion ${suffix}`] });
    expect(result).toMatchObject({ ok: true, avoidAllergens: ["peanuts"], avoidIngredients: [`yellow onion ${suffix}`] });
    expect(result).not.toHaveProperty("ask");
    expect(result).not.toHaveProperty("cannotCheck");
    const saved = await readConstraints(storeA, ctx.conversationId);
    expect(saved.avoidAllergens).toEqual(["peanuts"]);
    expect(saved.avoidIngredients).toEqual([{ term: `yellow onion ${suffix}`, ingredientId: onionId }]);
  });

  it("an allergen is a hard constraint with no question", async () => {
    const ctx = await conversation(storeA);
    const result = await setShopperNeeds(ctx, { avoid_allergens: ["peanuts"] });
    expect(result).not.toHaveProperty("ask");
    expect(await addToCart(ctx, { items: [{ variant_id: listing.peanut.variantId, qty: 1 }] })).toMatchObject({ code: "excluded" });
  });

  it("asks about a term that only names a form of a known ingredient: all blocks every form, only that form is a preference", async () => {
    const ctx = await conversation(storeA);
    const asked = await setShopperNeeds(ctx, { avoid_ingredients: [`fresh tomato ${suffix}`] });
    expect(asked).toMatchObject({ ok: true, ask: [{ term: `fresh tomato ${suffix}`, closest: expect.arrayContaining([`tomato ${suffix}`]) }], preferences: [`fresh tomato ${suffix}`] });
    expect((await readConstraints(storeA, ctx.conversationId)).avoidIngredients).toEqual([]);
    // Only fresh: a preference gates nothing, so the paste (made of tomato) is added.
    expect(items(await searchCatalog(ctx, { query: `paste plain ${suffix}` })).find((item) => item.listingId === listing.plain.listingId)?.match).toBe("name");
    expect(await addToCart(ctx, { items: [{ variant_id: listing.plain.variantId, qty: 1 }] })).toMatchObject({ ok: true, added: 1 });

    // All tomato: a hard constraint on the ingredient blocks the paste.
    const all = await conversation(storeA);
    await setShopperNeeds(all, { avoid_ingredients: [`fresh tomato ${suffix}`] });
    const saved = await setShopperNeeds(all, { avoid_ingredients: [`tomato ${suffix}`] });
    expect(saved).not.toHaveProperty("ask");
    // The hard constraint replaces the preference it answered.
    expect(saved).toMatchObject({ avoidIngredients: [`tomato ${suffix}`], preferences: [] });
    expect(await addToCart(all, { items: [{ variant_id: listing.plain.variantId, qty: 1 }] })).toMatchObject({ ok: false, code: "excluded" });
    expect(items(await searchCatalog(all, { query: `paste plain ${suffix}` })).map((item) => item.listingId)).not.toContain(listing.plain.listingId);
  });

  it("says once that a term with no close ingredient cannot be checked, and saves nothing for it", async () => {
    const ctx = await conversation(storeA);
    const result = await setShopperNeeds(ctx, { avoid_ingredients: [`zzunknown ${suffix}`] });
    expect(result).toMatchObject({ ok: true, cannotCheck: [`zzunknown ${suffix}`] });
    expect(result).not.toHaveProperty("ask");
    const saved = await readConstraints(storeA, ctx.conversationId);
    expect(saved.avoidIngredients).toEqual([]);
    expect(saved.preferences).toEqual([]);
    const search = await searchCatalog(ctx, { query: `paste ${suffix}` });
    expect(search).not.toHaveProperty("cannotCheck");
    expect(items(search).find((item) => item.listingId === listing.plain.listingId)?.match).toBe("name");
  });

  it("filters search in SQL: excluded never returns, unknown returns marked and not as a fit", async () => {
    const ctx = await conversation(storeA);
    await setShopperNeeds(ctx, { avoid_allergens: ["peanuts"], require_claims: [], avoid_ingredients: [`yellow onion ${suffix}`] });
    const found = items(await searchCatalog(ctx, { query: `paste ${suffix}` }));
    const byId = new Map(found.map((item) => [item.listingId, item]));
    expect(byId.has(listing.onion.listingId)).toBe(false);
    expect(byId.has(listing.peanut.listingId)).toBe(false);
    expect(byId.get(listing.plain.listingId)).toMatchObject({ match: "name", needs: { peanuts: "ok", [`yellow onion ${suffix}`]: "ok" } });
    expect(byId.get(listing.unknown.listingId)).toMatchObject({ match: "cannot_confirm", needs: { peanuts: "unknown" } });

    const halal = await conversation(storeA);
    await setShopperNeeds(halal, { avoid_allergens: [], require_claims: ["halal"], avoid_ingredients: [] });
    const halalIds = items(await searchCatalog(halal, { query: `paste ${suffix}` })).map((item) => item.listingId);
    expect(halalIds).toContain(listing.plain.listingId);
    expect(halalIds).not.toContain(listing.peanut.listingId);
  });

  it("matches the TypeScript attribute rule for every listing", async () => {
    const ctx = await conversation(storeA);
    await setShopperNeeds(ctx, { avoid_allergens: ["peanuts"], require_claims: ["halal"], avoid_ingredients: [`yellow onion ${suffix}`] });
    const constraints = await readConstraints(storeA, ctx.conversationId);
    const verdicts = await listingVerdicts(storeA, Object.values(listing).map((row) => row.listingId), constraints);
    expect(verdicts.has(listing.otherStore.listingId)).toBe(false);
    for (const [name, row] of Object.entries(listing)) {
      if (name === "otherStore") continue;
      const attributes = await listingAttributes(storeA, row.listingId);
      const { checkNeed } = await import("../../catalog/attributes");
      const expected = checkNeed(attributes!, { avoidAllergens: ["peanuts"], requireClaims: ["halal"], avoidIngredientIds: [onionId] });
      expect(verdicts.get(row.listingId)?.status, name).toBe(expected === "cannot_confirm" ? "unknown" : expected);
    }
  });

  it("keeps store B's attribute correction out of store A", async () => {
    const a = await conversation(storeA);
    const b = await conversation(storeB);
    for (const ctx of [a, b]) await setShopperNeeds(ctx, { avoid_allergens: ["peanuts"], require_claims: [], avoid_ingredients: [] });
    const inA = items(await searchCatalog(a, { query: `mystery ${suffix}` }));
    const inB = items(await searchCatalog(b, { query: `mystery ${suffix}` }));
    expect(inA.map((item) => item.listingId)).not.toContain(listing.otherStore.listingId);
    expect(inA.find((item) => item.listingId === listing.unknown.listingId)?.needs).toEqual({ peanuts: "unknown" });
    expect(inB.map((item) => [item.listingId, item.needs?.peanuts])).toEqual([[listing.otherStore.listingId, "ok"]]);
  });

  it("refuses an excluded item at the cart and the swap rule, with the reason", async () => {
    const ctx = await conversation(storeA);
    await setShopperNeeds(ctx, { avoid_allergens: ["peanuts"], require_claims: [], avoid_ingredients: [] });
    const refused = await addToCart(ctx, { items: [{ variant_id: listing.peanut.variantId, qty: 1 }] });
    expect(refused).toMatchObject({ ok: false, code: "excluded" });
    expect(String((refused as { message: string }).message)).toContain("peanuts");
    expect(await storeScoped(storeA).cartLine.count({ where: { cartId: ctx.cartId } })).toBe(0);

    const added = await addToCart(ctx, { items: [{ variant_id: listing.plain.variantId, qty: 1 }] });
    expect(added).toMatchObject({ ok: true });
    const lineId = (added as unknown as { lineId: string }).lineId;
    const offered = await offerChoices(ctx, { options: [listing.plain, listing.peanut, listing.unknown].map((row) => ({ listing_id: row.listingId })) });
    expect(offered).toMatchObject({ ok: true, excluded: [listing.peanut.listingId] });
    const swap = await setSwapRule(ctx, { line_id: lineId, rule: "named_substitute", substitute_variant_id: listing.peanut.variantId });
    expect(swap).toMatchObject({ ok: false, code: "excluded" });
  });

  it("adds an unknown item only after the customer confirms that one item, and records it", async () => {
    const first: ShownMessage = { role: "user", id: `u1-${suffix}`, parts: [{ type: "text", text: `I have a peanut allergy. Add 1 Paste mystery ${suffix}` }] };
    const ctx = await conversation(storeA, [first]);
    await setShopperNeeds(ctx, { avoid_allergens: ["peanuts"], require_claims: [], avoid_ingredients: [] });
    const turn1 = { ...ctx, turnMessageId: first.id!, acceptance: acceptanceForTurn([first], first.id!, first.parts[0].text!) };
    const asked = await addToCart(turn1, { items: [{ variant_id: listing.unknown.variantId, qty: 1 }] });
    expect(asked).toMatchObject({ ok: false, code: "cannot_confirm" });
    expect(await storeScoped(storeA).cartLine.count({ where: { cartId: ctx.cartId } })).toBe(0);

    // Retrying in the same turn is not a confirmation.
    expect(await addToCart(turn1, { items: [{ variant_id: listing.unknown.variantId, qty: 1 }] })).toMatchObject({ code: "cannot_confirm" });

    const reply: ShownMessage = { role: "assistant", id: `a1-${suffix}`, parts: [{ type: "text", text: `I can't confirm Paste mystery ${suffix} is peanut-free. Add it anyway?` }] };
    const yes: ShownMessage = { role: "user", id: `u2-${suffix}`, parts: [{ type: "text", text: "Yes, add it." }] };
    const messages = [first, reply, yes];
    await storeScoped(storeA).aiConversation.update({ where: { id: ctx.conversationId }, data: { messages: messages as never } });
    const turn2 = { ...ctx, turnMessageId: yes.id!, acceptance: acceptanceForTurn(messages, yes.id!, "Yes, add it.") };
    const confirmed = await addToCart(turn2, { items: [{ variant_id: listing.unknown.variantId, qty: 1 }] });
    expect(confirmed).toMatchObject({ ok: true, added: 1 });
    const saved = await readConstraints(storeA, ctx.conversationId);
    expect(saved.confirmed).toEqual([expect.objectContaining({ listingId: listing.unknown.listingId, messageId: yes.id, needs: ["peanuts"] })]);

    // A need added later was never confirmed for this item: it is asked about again.
    await setShopperNeeds(ctx, { avoid_allergens: ["sesame"], require_claims: ["halal"], avoid_ingredients: [] });
    const more: ShownMessage = { role: "user", id: `u3-${suffix}`, parts: [{ type: "text", text: `I also need halal and no sesame. Add another Paste mystery ${suffix}.` }] };
    const later = [...messages, { role: "assistant", id: `a2-${suffix}`, parts: [{ type: "text", text: "Added." }] } as ShownMessage, more];
    await storeScoped(storeA).aiConversation.update({ where: { id: ctx.conversationId }, data: { messages: later as never } });
    const turn3 = { ...ctx, turnMessageId: more.id!, acceptance: acceptanceForTurn(later, more.id!, more.parts[0].text!) };
    const again = await addToCart(turn3, { items: [{ variant_id: listing.unknown.variantId, qty: 1 }] });
    expect(again).toMatchObject({ ok: false, code: "cannot_confirm", needs: { peanuts: "unknown", sesame: "unknown", halal: "unknown" } });
    expect(await storeScoped(storeA).cartLine.findFirst({ where: { cartId: ctx.cartId } })).toMatchObject({ qty: 1 });
  });

  it("never leaves a constrained shopper's may-be-unavailable line to the store's unchecked swap", async () => {
    const lineOf = async (ctx: AssistantContext) => storeScoped(storeA).cartLine.findFirstOrThrow({ where: { cartId: ctx.cartId } });
    for (const backup of [listing.peanut.variantId, listing.unknown.variantId, undefined]) {
      const ctx = await conversation(storeA);
      await setShopperNeeds(ctx, { avoid_allergens: ["peanuts"], require_claims: [], avoid_ingredients: [] });
      const added = await addToCart(ctx, { items: [{ variant_id: listing.shaky.variantId, qty: 1, ...(backup ? { backup_variant_id: backup } : {}) }] });
      expect(added, String(backup)).toMatchObject({ ok: true, mayBeUnavailable: true, swapRule: "exact_only" });
      expect(await lineOf(ctx)).toMatchObject({ swapRule: "exact_only", substituteVariantId: null });
    }

    // A backup that passes is still kept.
    const kept = await conversation(storeA);
    await setShopperNeeds(kept, { avoid_allergens: ["peanuts"], require_claims: [], avoid_ingredients: [] });
    expect(await addToCart(kept, { items: [{ variant_id: listing.shaky.variantId, qty: 1, backup_variant_id: listing.plain.variantId }] }))
      .toMatchObject({ ok: true, swapRule: "named_substitute", substituteVariantId: listing.plain.variantId });

    // The store's swap is refused with the reason; a refund is allowed on this line.
    const lineId = (await lineOf(kept)).id;
    const store = await setSwapRule(kept, { line_id: lineId, rule: "store_suggests" });
    expect(store).toMatchObject({ ok: false, code: "unchecked_swap" });
    expect(await lineOf(kept)).toMatchObject({ swapRule: "named_substitute" });
    expect(await setSwapRule(kept, { line_id: lineId, rule: "exact_only" })).toMatchObject({ ok: true, swapRule: "exact_only" });

    // With no constraints, nothing changes.
    const free = await conversation(storeA);
    expect(await addToCart(free, { items: [{ variant_id: listing.shaky.variantId, qty: 1 }] })).toMatchObject({ ok: true, swapRule: "store_suggests" });
  });
});
